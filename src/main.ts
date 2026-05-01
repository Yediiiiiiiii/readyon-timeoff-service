import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { join } from 'path';
import { AppModule } from './app.module';
import { applyStaticDashboard } from './bootstrap';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['log', 'warn', 'error'],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  applyStaticDashboard(app, join(process.cwd(), 'public'));

  const cfg = new DocumentBuilder()
    .setTitle('ReadyOn Time-Off Microservice')
    .setDescription('Manages time-off lifecycle and HCM balance integrity.')
    .setVersion('1.0')
    .build();
  const doc = SwaggerModule.createDocument(app, cfg);
  SwaggerModule.setup('docs', app, doc);

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  new Logger('bootstrap').log(`Time-Off service listening on :${port}`);
}

void bootstrap();
