import { Module, type DynamicModule } from '@nestjs/common'
import type { Pool } from 'pg'
import type { CofreDeAcesso } from './redis/cofre-de-acesso.js'
import type { LimiteDeTentativas } from './redis/limite-de-tentativas.js'
import { COFRE, LIMITE } from './redis/tokens.js'
import { ContasController, POOL } from './contas/contas.controller.js'
import { LancamentosController } from './lancamentos/lancamentos.controller.js'
import { CartoesController } from './cartoes/cartoes.controller.js'
import { SessoesController } from './autenticacao/sessoes.controller.js'
import { CategoriasController } from './categorias/categorias.controller.js'
import { AlertasController } from './alertas/alertas.controller.js'
import { ObjetivosController } from './objetivos/objetivos.controller.js'
import { PlanejamentosController } from './planejamentos/planejamentos.controller.js'
import { RecorrenciasController } from './recorrencias/recorrencias.controller.js'

@Module({})
export class AppModule {
  static comPool(
    pool: Pool,
    cofre: CofreDeAcesso,
    limite: LimiteDeTentativas,
  ): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        SessoesController,
        ContasController,
        CategoriasController,
        AlertasController,
        ObjetivosController,
        PlanejamentosController,
        RecorrenciasController,
        LancamentosController,
        CartoesController,
      ],
      providers: [
        { provide: POOL, useValue: pool },
        { provide: COFRE, useValue: cofre },
        { provide: LIMITE, useValue: limite },
      ],
    }
  }
}
