import { Module, type DynamicModule } from '@nestjs/common'
import type { Pool } from 'pg'
import { ContasController, POOL } from './contas/contas.controller.js'
import { LancamentosController } from './lancamentos/lancamentos.controller.js'

@Module({})
export class AppModule {
  static comPool(pool: Pool): DynamicModule {
    return {
      module: AppModule,
      controllers: [ContasController, LancamentosController],
      providers: [{ provide: POOL, useValue: pool }],
    }
  }
}
