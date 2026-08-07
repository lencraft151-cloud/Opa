import { Router } from 'express';
import type { CreateRuleInput } from '../../services/automationService.js';
import type { Container } from '../../container.js';
import { asyncHandler, parseBody } from '../http.js';
import { ruleSchema, ruleUpdateSchema } from '../validation.js';

export function automationRoutes(container: Container): Router {
  const router = Router();

  router.get('/automations', (_req, res) => {
    const household = container.households.require();
    res.json(container.automations.list(household.id));
  });

  router.get('/automations/:id', (req, res) => {
    res.json(container.automations.get(req.params.id as string));
  });

  /**
   * Beispiel-Body:
   * {
   *   "name": "Bad heizen",
   *   "trigger": { "type":"sensor", "deviceId":"dev_…", "metric":"temperatureC",
   *                "operator":"<", "value":19, "forSeconds":300 },
   *   "conditions": [{ "type":"timeRange", "from":"06:00", "to":"22:00" }],
   *   "actions": [{ "type":"command", "target":{"deviceIds":["dev_…"]},
   *                 "command":{"type":"setPower","on":true} }],
   *   "cooldownSeconds": 900
   * }
   */
  router.post(
    '/automations',
    asyncHandler(async (req, res) => {
      const household = container.households.require();
      const input = parseBody(ruleSchema, req) as CreateRuleInput;
      res.status(201).json(await container.automations.create(household.id, input));
    }),
  );

  router.patch(
    '/automations/:id',
    asyncHandler(async (req, res) => {
      const changes = parseBody(ruleUpdateSchema, req) as Partial<CreateRuleInput>;
      res.json(await container.automations.update(req.params.id as string, changes));
    }),
  );

  router.delete(
    '/automations/:id',
    asyncHandler(async (req, res) => {
      await container.automations.remove(req.params.id as string);
      res.status(204).end();
    }),
  );

  /** Führt die Aktionen sofort aus – zum Testen einer neuen Regel. */
  router.post(
    '/automations/:id/run',
    asyncHandler(async (req, res) => {
      res.json(await container.automations.run(req.params.id as string));
    }),
  );

  return router;
}
