# thai-deploy-checklist: deploy / rollback checklist

## เป้าหมาย

ช่วยตรวจสอบก่อน deploy และมี rollback plan ชัดเจน

## checklist ก่อน deploy

- [ ] tests ผ่าน
- [ ] build ผ่าน
- [ ] env vars ถูกต้อง
- [ ] migration พร้อม
- [ ] backup พร้อม
- [ ] rollback plan พร้อม
- [ ] monitoring/alerts พร้อม
- [ ] communication plan พร้อม

## rollback

1. หยุด deploy
2. revert version
3. restore data (ถ้าจำเป็น)
4. verify health
5. แจ้งทีม/ลูกค้า

## กฎ

- อย่า deploy โดยไม่มี rollback
- ถ้าไม่มั่นใจ ให้ deploy staging ก่อน
- อย่าแก้ production โดยไม่บันทึก

## ตัวอย่าง prompt

"นี่คือขั้นตอน deploy ของเรา: ... ช่วยทำ checklist ตาม thai-deploy-checklist และระบุ missing items"