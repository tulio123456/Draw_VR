# AirDraw — POWERED by TULIO

Site para desenhar no ar usando a webcam e o rastreamento de mãos do MediaPipe.

## O que foi melhorado

- Interface mais limpa, simples e profissional.
- Projeto totalmente estático e pronto para Vercel.
- Rastreamento limitado a uma mão para reduzir travamentos.
- Suavização One Euro para diminuir tremores sem deixar o cursor muito atrasado.
- Histerese e confirmação por quadros na pinça para ela não ficar ligando e desligando.
- Correção de coordenadas quando a webcam é cortada por `object-fit: cover`.
- Proteção contra saltos grandes do rastreamento.
- Processamento com limite de FPS configurável.
- Tentativa automática com GPU e fallback para CPU.
- Fallback de CDN para carregar o MediaPipe.
- Suporte a mouse e toque para testar sem a câmera.


## Correção de estabilidade — versão 2.1

- A mão precisa aparecer em 3 quadros consecutivos antes de ser confirmada.
- Pequenas falhas de até 10 quadros não reiniciam a detecção nem fazem a interface piscar.
- O desenho para rapidamente se o rastreamento falhar, evitando linhas atravessando a tela.
- A pinça usa confirmação maior para não ligar e desligar sozinha.
- Corrigida a atribuição da webcam e uma referência a botão inexistente.
- O parâmetro de versão do `app.js` evita que o navegador reutilize o JavaScript antigo após um novo deploy no Vercel.

## Gestos

- **Pinça:** junte o polegar e o indicador para desenhar.
- **Mão aberta:** mova a mão sem desenhar.

## Ferramentas

Pincel, neon, marcador, borracha, linha, retângulo e círculo. Também há escolha de cor, grossura, suavização, desfazer, refazer, limpar e salvar em PNG.

## Testar no computador

### Opção 1 — Windows

Execute `INICIAR_LOCAL.bat`.

### Opção 2 — VS Code

Abra a pasta e utilize a extensão **Live Server** no arquivo `index.html`.

> A webcam normalmente funciona apenas em `localhost` ou em páginas HTTPS. Abrir o HTML diretamente como `file://` pode bloquear a câmera.

## Publicar no Vercel

### Pelo site do Vercel

1. Coloque esta pasta em um repositório no GitHub.
2. No Vercel, clique em **Add New > Project**.
3. Importe o repositório.
4. Em **Framework Preset**, escolha **Other**.
5. Não preencha Build Command nem Output Directory.
6. Clique em **Deploy**.

### Pela linha de comando

```bash
npm install -g vercel
vercel
```

Execute o comando dentro da pasta do projeto. O arquivo `vercel.json` já contém as permissões e cabeçalhos necessários.

## Observações

- É necessário ter internet na primeira abertura para carregar o pacote e o modelo do MediaPipe.
- No Vercel, o site usa HTTPS automaticamente, permitindo a solicitação de acesso à webcam.
- O vídeo é processado localmente no navegador. O projeto não envia a imagem da câmera para um servidor próprio.
