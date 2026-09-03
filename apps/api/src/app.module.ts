import { Module, type DynamicModule } from '@nestjs/common'
import type { Pool } from 'pg'
import { ContasController, POOL } from './contas/contas.controller.js'
import { LancamentosController } from './lancamentos/lancamentos.controller.js'
import { CartoesController } from './cartoes/cartoes.controller.js'
import { SessoesController } from './autenticacao/sessoes.controller.js'
import { CategoriasController } from './categorias/categorias.controller.js'
import { ObjetivosController } from './objetivos/objetivos.controller.js'
import { PlanejamentosController } from './planejamentos/planejamentos.controller.js'
import { RecorrenciasController } from './recorrencias/recorrencias.controller.js'

@Module({})
export class AppModule {
  static comPool(pool: Pool): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        SessoesController,
        ContasController,
        CategoriasController,
        ObjetivosController,
        PlanejamentosController,
        RecorrenciasController,
        LancamentosController,
        CartoesController,
      ],
      providers: [{ provide: POOL, useValue: pool }],
    }
  }
}
