import fastifyCookie from '@fastify/cookie';
import { ValidationPipe } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

// Shared by main.ts and the e2e tests so both run the exact same app.
export async function configureApp(app: NestFastifyApplication) {
  await app.register(fastifyCookie);
  app.enableCors({
    origin: process.env.CORS_ORIGIN?.split(',') ?? false,
    credentials: true,
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
}
