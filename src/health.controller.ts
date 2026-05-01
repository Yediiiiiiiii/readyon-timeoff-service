import { Controller, Get, Redirect } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

@Controller()
export class HealthController {
  @Get('healthz')
  health() {
    return { status: 'ok' };
  }
}

@ApiExcludeController()
@Controller()
export class RootController {
  @Get('/')
  @Redirect('/ui/', 302)
  redirectRoot() {
    return null;
  }
}
