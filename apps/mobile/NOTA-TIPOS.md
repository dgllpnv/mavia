# Por que `@types/react` é 19 aqui

O React Native 0.76 traz React 18.3 em tempo de execução, e a recomendação
natural seria `@types/react@18`. Foi o que estava, e quebrou o `apps/web`.

**O motivo:** duas versões de `@types/react` no mesmo workspace fazem
`ReactNode` virar dois tipos estruturalmente distintos. O `apps/web` usa React
19, e o `packages/ui`, que os dois consomem, não declara React nenhum — então a
resolução dele passou a depender de qual das duas versões o pnpm colocasse mais
perto. O typecheck do web passou a falhar em `cartao.tsx` com "ReactNode não é
atribuível a React.ReactNode", que é a mensagem que essa situação sempre produz.

**A escolha:** uma versão só de tipos no workspace, a 19. Os tipos são de
compilação; o runtime do app continua sendo o React 18.3 que o RN traz. Se
algum dia um tipo do 19 descrever mal uma API do 18, o erro aparece no
`typecheck` do próprio app — que é onde ele deve aparecer, e não numa tela.

A alternativa seria fixar tudo em 18 e prender o web numa versão de tipos
anterior ao React que ele de fato usa. Essa é pior: erraria do lado do produto
que está em produção.
