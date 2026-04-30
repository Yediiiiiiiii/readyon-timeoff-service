import { NestExpressApplication } from '@nestjs/platform-express';
import { Response } from 'express';
import * as fs from 'fs';
import { join } from 'path';

/**
 * Mount the dashboard at /ui from the supplied directory. Used by main.ts
 * for the live server and by the e2e test harness so static-asset behavior
 * is identical in both.
 */
export function applyStaticDashboard(
  app: NestExpressApplication,
  rootPath: string,
): void {
  if (!fs.existsSync(rootPath)) {
    return;
  }
  app.useStaticAssets(rootPath, {
    prefix: '/ui',
    index: 'index.html',
    fallthrough: true,
  });
  app.getHttpAdapter().get('/ui', (_req, res: Response) => {
    res.sendFile(join(rootPath, 'index.html'));
  });
}
