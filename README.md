# TK MultiStream

**TK = Twitch + Kick.** Chat e farm de pontos para a **Kick e a Twitch**, feito para a comunidade do PokeIdle. Ele mantém algumas lives em segundo plano, com o mínimo de memória e internet, para acumular pontos do canal e comprar bônus.

É um fork do [Kickterino](https://github.com/ViinniSantoos/kickterino), de VinniiSaantos, com suporte à Twitch.

> ## ⚠️ Aviso: use por sua conta e risco
>
> Este app assiste lives sem você estar presente, coleta o baú de bônus da Twitch sozinho e lê páginas da Kick, da Twitch e do PokeIdle com a sua sessão. **Isso pode ir contra os termos de uso da Kick, da Twitch e do PokeIdle**, e as plataformas podem limitar, suspender ou banir contas que usam automação.
>
> **Quem instala e usa o app assume sozinho todo o risco sobre as próprias contas.** O software é entregue "como está", sem garantia de nenhum tipo (veja a [licença MIT](LICENSE)). Os autores e quem publicou este código não se responsabilizam por contas suspensas ou banidas, pontos ou bônus perdidos, nem por qualquer outro prejuízo causado pelo uso do app.
>
> Projeto independente, sem ligação com a Kick, a Twitch ou o PokeIdle. Os nomes e marcas pertencem aos seus donos.

## Recursos

- **Chat em abas** de canais da Kick e da Twitch, com selo **K** (verde) e **T** (roxo) para saber qual é qual.
- **Farm nas duas plataformas ao mesmo tempo**, cada uma com a própria conta e as próprias vagas de live.
- **Painel de pontos** com a Twitch à esquerda e a Kick à direita: saldo, status e ganho de cada canal.
- **Baú de bônus da Twitch** (+50 pontos a cada ~15 min) coletado sozinho.
- **Bônus do PokeIdle por plataforma:** tempo restante de cada bônus da Twitch e da Kick, lido do jogo aberto no app ou digitado à mão, com aviso antes de acabar.
- **Foco em bônus:** as vagas vão para os canais mais perto de 300 pontos, depois 500, 1.000 e cada milhar seguinte.
- **Modo leve:** lives ocultas em 160p, sem som, sem imagens e sem anúncios.
- **Modo 24/7:** fica na bandeja, inicia com o Windows e se recupera de quedas e de suspensão.

## Como funciona

O app é feito em Electron e não tem servidor próprio.

- Cada live é a página real da Kick ou da Twitch, aberta numa janela invisível e sem som, com a sessão de cada plataforma separada.
- **Kick:** uma janela oculta em `kick.com` consulta status e saldo com a sessão da própria pessoa, e o chat vem da conexão que a página da Kick já abre.
- **Twitch:** o chat vem do IRC oficial da Twitch (só leitura sem login; para enviar, a pessoa conecta o próprio app da Twitch). Quem está ao vivo vem da API Helix. O saldo e o baú são lidos da página da live que está tocando.
- **PokeIdle:** o jogo aceita só uma sessão por conta, então o app nunca abre o jogo escondido. O botão "Abrir PokeIdle" abre o jogo numa janela onde a pessoa joga, e o app lê os tempos de bônus das mensagens que o próprio jogo recebe.
- A cada minuto, o app confere o estado dos canais e reorganiza as vagas.

## Configurar a Twitch

1. Ative a verificação em duas etapas na sua conta da Twitch.
2. Em [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps), registre um app:
   - nome sem a palavra "Twitch";
   - OAuth Redirect URL `http://localhost`;
   - categoria **Chat Bot**;
   - tipo **Confidencial**.
3. Copie o **Client ID**, gere um **Client Secret** (uma vez só) e cole os dois no botão **Twitch ⚙** do app. Cuidado para não trocar um pelo outro.
4. Clique em **Login Twitch** e entre na conta que vai ganhar os pontos.
5. Opcional: **Twitch ⚙ → Conectar chat**, para enviar mensagens.

Para adicionar canais da Twitch, use `twitch:canal` ou cole o link `twitch.tv/canal` no **+** das abas.

## O que os testes mostraram

- A Kick conta cerca de 2 lives por vez por conta. Com 2, 3, 4 ou 10 lives abertas, o ganho total foi o mesmo.
- O limite vale entre aparelhos: celular e TV disputam as mesmas 2 vagas com o app.
- Na Kick, a primeira contagem leva cerca de 6–7 min depois que a live abre. Depois, são +10 a cada ~5–6 min, ou cerca de 220 pontos por hora.
- Na Twitch, ferramentas conhecidas de farm também só contam 2 lives por vez. Não há documento oficial da Twitch sobre isso.

## Segurança da conta

- O login é feito na própria página da Kick, da Twitch, do Google, da Apple ou do Discord. O app não lê nem guarda a senha.
- Não há servidor do TK MultiStream: as sessões, o Client Secret e o token da Twitch ficam só no seu PC.
- Só a Kick, a Twitch, o PokeIdle e as páginas de login abrem dentro do app. Outros sites são bloqueados, e nenhuma página acessa câmera, microfone ou localização.
- **Sair da conta** apaga do app os dados de login da plataforma escolhida, mantendo a lista de canais e as preferências.
- Nunca envie a pasta de dados do app nem o seu Client Secret para ninguém.

## Desenvolvimento

Requer Node.js.

```bash
npm install
npm start
```

Para gerar o instalador e a versão portátil em `dist/`:

```bash
npm run dist
```

## Limitações

- Funciona só no Windows (há uma versão para Linux herdada do original, não testada com a Twitch).
- O saldo e o envio de mensagens da Kick, e o saldo e o baú da Twitch, dependem de páginas e endpoints internos que podem mudar sem aviso.
- Na Twitch, o saldo acima de 1.000 aparece arredondado ("1,2 mil").
- O app ainda não tem assinatura digital, então o Windows pode exibir um aviso na instalação.

## Licença

[MIT](LICENSE). Mantém o aviso de copyright do Kickterino original.
