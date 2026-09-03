import { Module, type DynamicModule } from '@nestjs/common'
import { APP_INTERCEPTOR } from '@nestjs/core'
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
import { ExportacaoController } from './exportacao/exportacao.controller.js'
import { RelatoriosController } from './relatorios/relatorios.controller.js'
import { AlterarLancamentoController, RegrasController } from './classificacao/classificacao.controller.js'
import { ConciliacoesController, ImportacaoController } from './importacao/importacao.controller.js'
import { IdempotenciaInterceptor } from './idempotencia/idempotencia.interceptor.js'
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
        RelatoriosController,
        ExportacaoController,
        RegrasController,
        AlterarLancamentoController,
        ImportacaoController,
        ConciliacoesController,
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
        // Global de propósito: idempotência escrita rota a rota é idempotência
        // que falta na rota nova. Aqui é propriedade do transporte, e vale para
        // qualquer mutação que traga `Idempotency-Key` — inclusive as que ainda
        // não existem.
        { provide: APP_INTERCEPTOR, useClass: IdempotenciaInterceptor },
      ],
    }
  }
}
