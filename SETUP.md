# Upload 기능 설정 가이드

## 1. D1 데이터베이스 스키마 생성

다음 명령어로 데이터베이스 테이블을 생성하세요:

```bash
# 로컬 데이터베이스에 스키마 적용
npx wrangler d1 execute aoya-pottery-db --local --file=./schemas/schema.sql

# 프로덕션 데이터베이스에 스키마 적용
npx wrangler d1 execute aoya-pottery-db --remote --file=./schemas/schema.sql
```

## 2. R2 API 자격 증명 설정

R2 버킷에 접근하기 위한 API 토큰을 생성하고 환경 변수로 설정해야 합니다.

1. Cloudflare 대시보드에서 R2 API 토큰 생성:
   - [R2 > Manage R2 API Tokens](https://dash.cloudflare.com/?to=/:account/r2/api-tokens)
   - "Object Read & Write" 권한으로 토큰 생성
   - Access Key ID와 Secret Access Key 복사

2. Wrangler secrets로 설정:

```bash
npx wrangler secret put AWS_ACCESS_KEY_ID
# 프롬프트가 나타나면 Access Key ID 입력

npx wrangler secret put AWS_SECRET_ACCESS_KEY
# 프롬프트가 나타나면 Secret Access Key 입력
```

## 3. 개발 서버 실행

```bash
npm run dev
```

브라우저에서 `http://localhost:5173/upload`로 접속하여 업로드 페이지를 확인할 수 있습니다.

## 4. 배포

```bash
npm run deploy
```

## 참고사항

- R2 버킷이 공개적으로 접근 가능하도록 설정되어 있어야 업로드된 이미지를 볼 수 있습니다.
- 이미지 URL 형식이 맞지 않다면 `app/routes/upload.tsx`의 URL 생성 부분을 수정하세요.

