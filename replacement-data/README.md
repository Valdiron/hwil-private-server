# Dados substitutos clean-room

Este diretório contém dados novos, criados do zero, para o servidor privado. Ele não contém carros,
pistas, músicas, marcas, modelos ou outros ativos proprietários do jogo original.

O comando `npm run build:data` valida os JSON, gera hashes SHA-256, monta a árvore de instalação do
Android e cria um OBB estrutural chamado `main.378.com.mattel.HWInfiniteLoop.obb`.

## Limite de compatibilidade

O APK original espera objetos serializados pelo Unity 2019.4 e cenas binárias que não existem no
APK enviado. Os substitutos deste pacote usam um esquema JSON aberto e, por isso, exigem uma ponte
no cliente para substituir o carregador original. Copiar o OBB sozinho não torna o jogo jogável.

Os arquivos em `compatibility/` registram os GUIDs e as cenas ausentes para orientar essa ponte.

