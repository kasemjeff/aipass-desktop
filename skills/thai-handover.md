# thai-handover: เอกสารส่งมอบ / runbook

## เป้าหมาย

ช่วยทำ handover pack สำหรับโปรเจกต์ที่ส่งมอบให้ทีม/ลูกค้า ลด knowledge loss

## โครงสร้าง

1. ภาพรวมระบบ
2. Architecture (high-level)
3. วิธีรัน (dev/staging/prod)
4. Environment variables (ไม่ใส่ secret)
5. Database / migration
6. Deployment steps
7. Rollback steps
8. Monitoring / logs
9. Backup / restore
10. Common issues & troubleshooting
11. Contacts / owners
12. Known limitations

## กฎ

- ห้ามใส่ secret/token/password ในเอกสาร
- ต้องมี rollback
- ต้องมี "ถ้า deploy พังทำอย่างไร"
- ถ้าไม่รู้ข้อมูล ให้ใส่ TODO แทนการเดา

## ตัวอย่าง prompt

"นี่คือโครงสร้างโปรเจกต์: ... ช่วยทำ handover ตาม thai-handover พร้อม rollback และ troubleshooting"