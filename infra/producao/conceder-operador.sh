#!/bin/sh
# Tornar alguém operador do painel — **ADR 0024**.
#
# ## Não existe conta de admin, e é decisão de arquitetura
#
# Ser operador é uma **concessão** a um usuário que já existe, com data,
# concedente nominal e trilha de auditoria. Uma conta separada seria uma
# credencial a mais para vazar e, pior, um ator sem dono nominal no registro: a
# auditoria diria "o admin fez", e "o admin" não é ninguém.
#
# Quem entra no painel entra com a conta de sempre — a mesma senha, ou o mesmo
# Google. O que muda é o que a concessão abre.
#
# ## A invariante das duas concessões
#
# `exigir_dois_admins_ativos()` (migration `0031`) impede que uma **revogação**
# deixe o sistema com menos de dois operadores ativos. Conceder o primeiro é
# livre; é descer que é barrado, e a razão é operacional: com um operador só,
# perder o acesso dele tranca o painel para sempre e não há segundo par de olhos
# para o aviso entre pares da §6.3 alcançar.
#
# Este script não força o segundo — ele **avisa**, porque a decisão de quem é o
# segundo operador é do dono do produto, não de um script.
set -eu

cd "$(dirname "$0")"
[ $# -eq 1 ] || { echo "uso: $0 <email-do-usuario>" >&2; exit 1; }
EMAIL="$1"

AMBIENTE=.env
[ -f "$AMBIENTE" ] || { echo "ERRO: $AMBIENTE não existe." >&2; exit 1; }

SENHA_POSTGRES=$(grep '^SENHA_POSTGRES=' "$AMBIENTE" | cut -d= -f2-)

# `--set` e não interpolação de shell: assim o e-mail não aparece na lista de
# processos, e um endereço com aspas não vira injeção.
docker compose exec -T -e PGPASSWORD="$SENHA_POSTGRES" postgres   psql --username mavia --dbname mavia --single-transaction --set ON_ERROR_STOP=1        --set email="$EMAIL" <<'SQL'

-- **Sem bloco `DO`, e a razão é uma pegadinha do psql.**
--
-- A primeira versão fazia a busca dentro de `DO $$ ... $$` e morria em
-- `syntax error at or near ":"`. O psql **não interpola variáveis dentro de
-- texto entre cifrões** — para ele o corpo do bloco é uma string opaca, e
-- `:'email'` chega literal ao servidor.
--
-- `\gset` resolve e melhora: ele falha em voz alta quando a consulta não
-- devolve linha, que é exatamente o caso "esse e-mail não tem conta". O bloco
-- `DO` precisaria de um `RAISE EXCEPTION` escrito à mão para o mesmo efeito.
--
-- `lower()` nos dois lados porque o índice único de `usuarios` é sobre
-- `lower(email)`: procurar sem normalizar acharia zero para quem se cadastrou
-- com uma maiúscula.
SELECT id AS uid FROM usuarios
 WHERE lower(email) = lower(:'email') AND deleted_at IS NULL
\gset

-- O primeiro operador se concede: não há quem o conceda antes dele. Do segundo
-- em diante, quem concede é quem já era — e a auditoria mostra a corrente.
SELECT admin.conceder(:'uid'::uuid, :'uid'::uuid) AS concessao;

SELECT count(*) AS operadores_ativos FROM concessoes_de_admin WHERE revogada_em IS NULL;

SQL

# A invariante de `exigir_dois_admins_ativos` (migration 0031) barra uma
# **revogação** que deixe menos de dois operadores; conceder o primeiro é livre.
# O aviso fica aqui, fora do SQL, porque a decisão de quem é o segundo é do dono
# do produto e não de um script.
ATIVOS=$(docker compose exec -T -e PGPASSWORD="$SENHA_POSTGRES" postgres   psql --username mavia --dbname mavia -tAc   'SELECT count(*) FROM concessoes_de_admin WHERE revogada_em IS NULL' | tr -d '[:space:]')
if [ "${ATIVOS:-0}" -lt 2 ]; then
  echo
  echo "ATENCAO: ha $ATIVOS operador ativo. Com um so, perder este acesso tranca"
  echo "o painel, e o aviso entre pares nao tem para quem ir. Conceda a um segundo."
fi

echo
echo "Pronto. Entre com a conta de sempre e vá para /admin."
