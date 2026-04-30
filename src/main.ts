import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'warn', 'error'],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

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
