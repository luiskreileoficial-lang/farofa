FAROFA - PROJETO RECONSTRUIDO

IMPORTANTE
Este pacote mantém o código original recuperado e acrescenta somente a nova regra de ativação por caracteres/números.

NOVA REGRA
A Farofa é chamada quando a mensagem contém qualquer um destes caracteres:
0123456789 @ # $ _ & - + ( ) / * " ' : ; ! ? ~ ` | • √ π ÷ × § ∆ \ } { = ° ^ ¥ € ¢ £ % © ® ™ ✓ [ ]

A chamada pelo nome, menção e resposta a uma mensagem da Farofa continuam funcionando.
Como a regra usa qualquer ocorrência, mensagens comuns que contenham pontuação ou números também podem ativar a IA. Comandos reconhecidos (como !menu) continuam sendo tratados antes da chamada da IA.

INSTALAÇÃO
1. Envie os arquivos do ZIP para o projeto Node.js da KataBump.
2. Configure a chave da OpenRouter em config.json, no campo OPENROUTER_API_KEY. Não compartilhe essa chave publicamente.
3. Use npm install e depois npm start.
4. Faça o pareamento do WhatsApp quando o terminal mostrar o QR Code.

OBSERVAÇÕES
- A pasta auth começa vazia. O pareamento precisará ser feito novamente.
- database.json começa vazio; dados antigos só podem ser recuperados com backup.
- O código foi verificado com node --check. A conexão real com KataBump, WhatsApp e OpenRouter ainda precisa ser testada no ambiente de hospedagem.
