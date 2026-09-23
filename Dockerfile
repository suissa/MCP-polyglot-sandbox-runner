FROM node:20-alpine

WORKDIR /app

# Instala TypeScript e utilitários globais
RUN npm install -g typescript ts-node

# Usuário não-root para reforçar a segurança junto ao gVisor
USER node

CMD ["sh"]