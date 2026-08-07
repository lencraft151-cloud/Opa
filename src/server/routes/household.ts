import { Router } from 'express';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { asyncHandler, parseBody } from '../http.js';

export function householdRoutes(container: Container): Router {
  const router = Router();

  router.get('/household', (_req, res) => {
    res.json(container.households.require());
  });

  router.patch(
    '/household',
    asyncHandler(async (req, res) => {
      const changes = parseBody(
        z.object({
          name: z.string().min(1).max(120).optional(),
          timezone: z.string().min(1).max(64).optional(),
          locale: z.string().min(2).max(16).optional(),
        }),
        req,
      );
      res.json(await container.households.update(changes));
    }),
  );

  /** Kennzahlen für das Dashboard. */
  router.get('/household/summary', (_req, res) => {
    const household = container.households.require();
    const summary = container.devices.summary(household.id);
    const rooms = container.rooms.list(household.id);
    const integrations = container.integrations.list(household.id);

    res.json({
      household,
      ...summary,
      rooms: rooms.length,
      integrations: {
        total: integrations.length,
        linked: integrations.filter((item) => item.status === 'linked').length,
        error: integrations.filter((item) => item.status === 'error').length,
      },
      automations: container.automations.list(household.id).length,
    });
  });

  // ---------------------------------------------------------------------------
  // Zugriffstoken
  // ---------------------------------------------------------------------------

  router.get('/household/tokens', (_req, res) => {
    res.json(
      container.households.listTokens().map((token) => ({
        id: token.id,
        name: token.name,
        createdAt: token.createdAt,
        lastUsedAt: token.lastUsedAt,
      })),
    );
  });

  router.post(
    '/household/tokens',
    asyncHandler(async (req, res) => {
      const { name } = parseBody(z.object({ name: z.string().min(1).max(80) }), req);
      const household = container.households.require();
      const { token, record } = await container.households.issueToken(household.id, name);
      res.status(201).json({
        id: record.id,
        name: record.name,
        createdAt: record.createdAt,
        accessToken: token,
        hint: 'Das Token wird nur einmal angezeigt.',
      });
    }),
  );

  router.delete(
    '/household/tokens/:id',
    asyncHandler(async (req, res) => {
      await container.households.revokeToken(req.params.id as string);
      res.status(204).end();
    }),
  );

  return router;
}
