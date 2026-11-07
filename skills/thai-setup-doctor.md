# thai-setup-doctor: ตั้งค่า/ซ่อม AiPASS Desktop

## เป้าหมาย

ช่วยผู้ใช้ติดตั้งและวินิจฉัยปัญหา AiPASS Desktop แบบทีละขั้น โดยไม่ข้ามความปลอดภัย

## ขั้นตอนพื้นฐาน

1. ตรวจ Node.js >= 20
2. clone repo และรัน `npm run setup`
3. เปิด Chrome → `chrome://extensions` → Developer mode → Load unpacked → `aipass-bridge/extension`
4. เปิด popup extension → Advanced → Loopback token → วาง `~/.aipass/.token`
5. เปิด `https://de.aipass.net/chat`, ล็อกอิน, ทิ้งแท็บไว้
6. รัน `aipass status`
7. ถ้ามีปัญหา รัน `aipass doctor`

## ปัญหาที่พบบ่อย

- ไม่มี tab attached → เปิด de.aipass.net/chat และทิ้งแท็บไว้
- model list fallback-only → sign in ใหม่แล้ว reload tab
- bridge not reachable → `npm run dev`
- credits 0 → รอรอบวันถัดไปหรือใช้ free-credit model
- 403 edge refusal → ดู `thai-waf-403`

## กฎ

- อย่าปิด auth token ใน production
- อย่าแชร์บัญชี/token
- อย่าแก้ WAF เพื่อหลบ block
- ถ้าไม่แน่ใจ ให้รัน doctor ก่อน

## ตัวอย่าง prompt

"ฉันรัน aipass doctor ได้ผลแบบนี้: ... ช่วยแปลความหมายและบอกขั้นตอนถัดไปตาม thai-setup-doctor"