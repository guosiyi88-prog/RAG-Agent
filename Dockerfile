FROM node:22-alpine

# pdftotext 是唯一的系统依赖。poppler-data 不可省：只装 poppler-utils 时
# CJK PDF（本仓库的语料就是中文 PDF）会报 "Missing language pack for 'Adobe-GB1'" 并输出空文本。
# wget 供 compose healthcheck 使用。
RUN apk add --no-cache poppler-utils poppler-data wget

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY sql ./sql

EXPOSE 8000

# 直接跑 .ts（Node 22 的类型剥离），不产出 JS、不引入构建链
CMD ["node", "src/server.ts"]
