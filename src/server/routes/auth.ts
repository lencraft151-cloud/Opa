import { Router } from 'express';
import { z } from 'zod';
import { badRequest, conflict } from '../../core/errors.js';
import type { Container } from '../../container.js';
import { SESSION_TTL_MS, toPublic } from '../../services/userService.js';
import { clearSessionCookie, requireAdmin, requireUser, setSessionCookie } from '../auth.js';
import { asyncHandler, parseBody } from '../http.js';
import {
  changePasswordSchema,
  createUserSchema,
  loginSchema,
  passwordSchema,
} from '../validation.js';

/**
 * Anmeldung und Benutzerverwaltung.
 *
 * Ein Zugriffstoken war für Menschen der falsche Schlüssel: einmal angezeigt,
 * nicht zu merken, nicht zu ändern. Hier gibt es stattdessen Name und
 * Passwort – und eine Sitzung, die man sehen und beenden kann.
 */
export function authRoutes(container: Container): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // Anmelden und abmelden
  // -------------------------------------------------------------------------

  router.post(
    '/auth/login',
    asyncHandler(async (req, res) => {
      const household = container.households.current();
      if (!household) {
        throw badRequest(
          'Dieser Hub ist noch nicht eingerichtet.',
          undefined,
          'Öffne die Startseite – der Einrichtungsassistent legt Haushalt und Zugang an.',
        );
      }

      const { username, password } = parseBody(loginSchema, req);
      const result = await container.users.login(
        household.id,
        username,
        password,
        req.headers['user-agent'],
      );

      setSessionCookie(req, res, result.token, SESSION_TTL_MS);
      res.json({ user: result.user, expiresAt: result.session.expiresAt });
    }),
  );

  router.post(
    '/auth/logout',
    asyncHandler(async (req, res) => {
      if (req.sessionId) await container.users.endSession(req.sessionId, req.user?.id ?? '');
      clearSessionCookie(req, res);
      res.status(204).end();
    }),
  );

  /** Wer bin ich? Die Oberfläche fragt das beim Start. */
  router.get('/auth/me', (req, res) => {
    if (!req.user) {
      res.json({
        user: null,
        // Ohne Anmeldepflicht oder mit Zugriffstoken gibt es keinen Benutzer.
        viaToken: Boolean(req.tokenId),
        authDisabled: container.config.authDisabled,
        userCount: container.households.current()
          ? container.users.count(container.households.require().id)
          : 0,
      });
      return;
    }
    res.json({
      user: toPublic(req.user),
      viaToken: false,
      authDisabled: false,
      userCount: container.users.count(req.user.householdId),
    });
  });

  router.post(
    '/auth/password',
    asyncHandler(async (req, res) => {
      const user = requireUser(req);
      const { currentPassword, newPassword } = parseBody(changePasswordSchema, req);
      await container.users.changePassword(user.id, currentPassword, newPassword, req.sessionId);
      res.json({
        ok: true,
        message: 'Passwort geändert. Andere angemeldete Geräte wurden abgemeldet.',
      });
    }),
  );

  // -------------------------------------------------------------------------
  // Sitzungen
  // -------------------------------------------------------------------------

  router.get('/auth/sessions', (req, res) => {
    const user = requireUser(req);
    res.json(
      container.users.listSessions(user.id).map((session) => ({
        ...session,
        current: session.id === req.sessionId,
      })),
    );
  });

  router.delete(
    '/auth/sessions/:id',
    asyncHandler(async (req, res) => {
      const user = requireUser(req);
      await container.users.endSession(req.params.id as string, user.id);
      if (req.params.id === req.sessionId) clearSessionCookie(req, res);
      res.status(204).end();
    }),
  );

  router.post(
    '/auth/sessions/end-others',
    asyncHandler(async (req, res) => {
      const user = requireUser(req);
      const ended = await container.users.endAllSessions(user.id, req.sessionId);
      res.json({ ended });
    }),
  );

  // -------------------------------------------------------------------------
  // Benutzerverwaltung
  // -------------------------------------------------------------------------

  router.get('/auth/users', (req, res) => {
    const user = requireUser(req);
    res.json(container.users.list(user.householdId));
  });

  router.post(
    '/auth/users',
    asyncHandler(async (req, res) => {
      const household = container.households.require();
      const input = parseBody(createUserSchema, req);

      /*
       * Sonderfall Nachrüstung: Ein Hub aus einer früheren Fassung hat einen
       * Haushalt, aber noch kein Benutzerkonto. Wer dort mit dem alten
       * Zugriffstoken hereinkommt, darf sich genau einmal ein Konto anlegen –
       * sonst käme er nach der Umstellung nicht mehr hinein.
       */
      const isBootstrap = container.users.count(household.id) === 0;
      if (isBootstrap) {
        if (!req.tokenId && !container.config.authDisabled) {
          throw badRequest(
            'Für das erste Konto wird das bisherige Zugriffstoken gebraucht.',
            undefined,
            'Sende es als "Authorization: Bearer <token>" mit – danach ist es nicht mehr nötig.',
          );
        }
      } else {
        requireAdmin(req);
      }

      const created = await container.users.create(household.id, input);

      // Beim Nachrüsten gleich anmelden, damit der Weg nicht auf halber
      // Strecke endet.
      if (isBootstrap) {
        const login = await container.users.login(household.id, input.username, input.password);
        setSessionCookie(req, res, login.token, SESSION_TTL_MS);
      }

      res.status(201).json(created);
    }),
  );

  router.patch(
    '/auth/users/:id',
    asyncHandler(async (req, res) => {
      requireAdmin(req);
      const changes = parseBody(
        z.object({
          displayName: z.string().max(80).optional(),
          role: z.enum(['admin', 'member']).optional(),
        }),
        req,
      );
      res.json(await container.users.update(req.params.id as string, changes));
    }),
  );

  /** Administrator setzt ein vergessenes Passwort zurück. */
  router.post(
    '/auth/users/:id/password',
    asyncHandler(async (req, res) => {
      const admin = requireAdmin(req);
      const { newPassword } = parseBody(z.object({ newPassword: passwordSchema }), req);
      const target = container.users.get(req.params.id as string);
      if (target.id === admin.id) {
        throw conflict(
          'Das eigene Passwort wird über „Passwort ändern" geändert.',
          undefined,
          'Dort wird das bisherige Passwort abgefragt – das ist der sichere Weg.',
        );
      }
      await container.users.resetPassword(target.id, newPassword);
      res.json({
        ok: true,
        message: `Neues Passwort für „${target.username}" gesetzt. Alle Geräte dieses Kontos wurden abgemeldet.`,
      });
    }),
  );

  router.delete(
    '/auth/users/:id',
    asyncHandler(async (req, res) => {
      const admin = requireAdmin(req);
      await container.users.remove(req.params.id as string, admin.id);
      res.status(204).end();
    }),
  );

  return router;
}
