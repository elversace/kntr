# kntr Mobile — مشروع iOS و Android (Capacitor)

هذا مشروع Capacitor حقيقي وقابل للبناء — يحوّل تطبيق kntr الموحّد (`www/index.html`) إلى تطبيق
iOS و Android أصلي.

## أول خطوة (إلزامية) — تثبيت الاعتماديات
`node_modules` تم استثناؤه من الحزمة لتصغير الحجم (~140 ميجا). قبل أي شي:
```bash
npm install
npx cap sync
```

## محتويات المشروع
- `www/index.html` — نفس التطبيق الموحّد (عميل + سائق)، مع إضافة زر "استخدم موقعي الحالي" (GPS حقيقي)
- `ios/` — مشروع Xcode كامل (يُفتح فقط على macOS)
- `android/` — مشروع Android Studio كامل
- `resources/` — أيقونة وشاشة البدء المصدرية (1024×1024 و2732×2732)
- `capacitor.config.json` — إعدادات التطبيق (App ID: `ly.kntr.app`)
- `store-listing/` — نصوص الإدراج، سياسة الخصوصية، الشروط والأحكام
- `LAUNCH-GUIDE.md` — **اقرأ هذا الملف أولاً** — دليل كامل بكل خطوات النشر الفعلية والمتبقية عليك

## قبل البناء — غيّر عنوان الـ API
افتح `www/index.html` وابحث عن:
```
http://localhost:3000/v1
```
واستبدله بعنوان السيرفر الفعلي المستضاف (لازم HTTPS في الإنتاج)، ثم أعد المزامنة:
```bash
npx cap sync
```

## البناء
راجع `LAUNCH-GUIDE.md` للتفاصيل الكاملة. باختصار:
- **Android:** افتح مجلد `android/` في Android Studio → Build → Generate Signed Bundle
- **iOS:** افتح `ios/App/App.xcworkspace` في Xcode (على Mac فقط) → Product → Archive
