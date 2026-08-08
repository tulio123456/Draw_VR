# AirDraw • Vercel + captura remota

## O que este projeto faz

- AirDraw controlado pela mão usando MediaPipe.
- Usa apenas **uma mão** para evitar detecção duplicada.
- Pinça polegar + indicador para desenhar.
- Cor, espessura, borracha, desfazer, limpar e salvar PNG.
- Usa a mesma câmera do AirDraw para gerar uma fotografia JPEG.
- Envia uma captura para outro servidor a cada **3 segundos**.
- O envio começa somente depois do consentimento explícito do usuário.
- Um indicador visível mostra quando o envio remoto está ativo.

## 1. Configure o servidor externo

Abra:

`config.js`

Troque:

```js
PHOTO_SERVER_URL: "http://localhost:4000"
```

por sua URL pública HTTPS, por exemplo:

```js
PHOTO_SERVER_URL: "https://fotos.seudominio.com"
```

## 2. Coloque na Vercel

A pasta `airdraw-vercel` é um site estático.

Opções:

- coloque os arquivos em um repositório GitHub e importe o repositório na Vercel;
- ou use Vercel CLI;
- ou Vercel Drop para uma pasta/ZIP estático.

Não é necessário armazenar as fotos na Vercel. O navegador envia as capturas diretamente
para o servidor configurado em `PHOTO_SERVER_URL`.

## 3. CORS

No servidor externo, configure:

```env
ALLOWED_ORIGINS=https://seu-airdraw.vercel.app
```

Durante testes locais:

```env
ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
```

É possível informar mais de uma origem separada por vírgula.

## Segurança/privacidade

O projeto não tenta esconder o uso da câmera nem o envio das imagens. O navegador pede
permissão de câmera e o AirDraw mostra um indicador vermelho enquanto as capturas estão
sendo enviadas.
