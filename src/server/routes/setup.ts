import { Router } from 'express';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { SESSION_TTL_MS } from '../../services/userService.js';
import { setSessionCookie } from '../auth.js';
import { asyncHandler, parseBody } from '../http.js';
import { firstUserSchema, householdSchema, setupStepSchema } from '../validation.js';

/**
 * Der Einrichtungsassistent. Die Reihenfolge ist:
 *   1. Haushalt anlegen  →  Token erhalten
 *   2. Hue Bridge / Shelly verbinden (siehe /api/integrations)
 *   3. Räume anlegen
 *   4. Geräte zuordnen
 *   5. Abschließen
 */
export function setupRoutes(container: Container): Router {
  const router = Router();

  router.get('/setup/state', (_req, res) => {
    res.json(container.setup.state());
  });

  router.get('/setup/suggested-rooms', (_req, res) => {
    res.json({ rooms: container.setup.suggestedRooms() });
  });

  router.post(
    '/setup/household',
    asyncHandler(async (req, res) => {
      const input = parseBody(householdSchema.merge(firstUserSchema), req);
      const result = await container.setup.createHousehold(input);

      // Ab jetzt laufen Polling und Automationen.
      await container.startBackgroundServices();

      // Direkt angemeldet weitermachen – ein zweites Formular wäre nur eine
      // Hürde zwischen „angelegt" und „benutzbar".
      setSessionCookie(req, res, result.sessionToken, SESSION_TTL_MS);

      res.status(201).json({
        household: result.household,
        state: result.state,
        user: result.user,
        hint: `Angemeldet als „${result.user.username}". Mit diesem Namen und deinem Passwort kommst du von jedem Gerät hinein.`,
      });
    }),
  );

  router.post(
    '/setup/step',
    asyncHandler(async (req, res) => {
      const { step } = parseBody(z.object({ step: setupStepSchema }), req);
      res.json(await container.setup.goToStep(step));
    }),
  );

  router.post(
    '/setup/rooms',
    asyncHandler(async (req, res) => {
      const { names } = parseBody(
        z.object({ names: z.array(z.string().min(1).max(80)).min(1).max(50) }),
        req,
      );
      res.json(await container.setup.createRooms(names));
    }),
  );

  router.post(
    '/setup/assign',
    asyncHandler(async (req, res) => {
      const { assignments } = parseBody(
        z.object({
          assignments: z
            .array(z.object({ deviceId: z.string().min(1), roomId: z.string().nullable() }))
            .min(1)
            .max(500),
        }),
        req,
      );
      res.json(await container.setup.assignDevices(assignments));
    }),
  );

  router.post(
    '/setup/complete',
    asyncHandler(async (_req, res) => {
      const state = await container.setup.complete();
      await container.startBackgroundServices();
      res.json(state);
    }),
  );

  return router;
}
