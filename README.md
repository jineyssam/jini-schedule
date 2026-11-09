# 지니 스케줄

개인 일정 웹앱(`site/`)과 푸시 알림 서버(`netlify/functions/`).

- `site/` — 앱 본체(단일 HTML + 서비스 워커). Netlify가 그대로 배포한다.
- `netlify/functions/push-key` — 푸시 공개키 제공(처음 호출 때 자동 생성, Netlify Blobs에 보관)
- `netlify/functions/push-sync` — 앱이 알림 목록·구독 기기를 올리는 곳(Firebase 로그인 토큰으로 본인 확인)
- `netlify/functions/push-cron` — 5분마다 시각이 된 알림을 발송
- `test/server.test.mjs` — 실제 암호화 푸시를 가짜 푸시 서버로 보내 복호화까지 확인하는 테스트

환경 변수는 필요 없다. 이 저장소를 Netlify 사이트에 연결하면 push할 때마다 자동 배포된다.
배포 1회마다 Netlify 크레딧 15가 차감되므로 수정은 모아서 올린다.
