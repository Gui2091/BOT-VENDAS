# Loja Oficial — REAL RP

Bot de loja com tickets privados, carrinho, atendimento humano e logs.

## Preparação

1. Instale o Node.js 20 ou superior.
2. Copie `.env.example` para `.env` e preencha `DISCORD_TOKEN`, `CLIENT_ID` e `GUILD_ID`.
3. Execute `npm install` e depois `npm start`.
4. Convide o bot com os escopos `bot` e `applications.commands` e conceda as permissões **Gerenciar Canais**, **Gerenciar Mensagens**, **Enviar Mensagens**, **Incorporar Links**, **Anexar Arquivos** e **Usar Comandos de Aplicativo**.

Ao iniciar, o bot publica (ou atualiza) o painel da loja no canal configurado. O comando `/loja` permite recriar o painel manualmente a administradores.

## PIX automático

Para ativar o PIX, informe `MERCADOPAGO_ACCESS_TOKEN` e um e-mail válido em `PAYMENT_PAYER_EMAIL` no `.env`. Sem essas configurações, o bot mantém o fluxo de pedido e deixa o pagamento marcado como pendente para o vendedor, sem inventar um código de cobrança.

## PayPal

Para exibir o pagamento por PayPal, informe em `PAYPAL_PAYMENT_URL` o link de pagamento da sua conta (por exemplo, um link PayPal.Me ou checkout). Após o cliente concluir o pagamento, um vendedor ainda precisa confirmar a entrega no ticket.

Os arquivos em `data/` guardam o estado dos tickets entre reinicializações e não devem ser versionados.
