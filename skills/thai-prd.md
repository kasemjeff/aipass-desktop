# thai-prd: แปลงความต้องการลูกค้าเป็น PRD/SRS

## เป้าหมาย

ช่วยนักพัฒนาไทยแปลงคำพูดลูกค้าให้เป็น PRD/SRS ที่ส่งมอบได้ โดยไม่แต่งความต้องการที่ไม่มีหลักฐาน

## ขั้นตอน

1. แยกข้อมูลที่ได้รับเป็น:
   - ความต้องการหลัก
   - ความต้องการรอง
   - ข้อจำกัด/budget/timeline
   - ความเสี่ยง
   - สิ่งที่ไม่รู้ / ต้องถามเพิ่ม
2. สร้าง PRD ด้วยโครงสร้างนี้:
   - 1. บทสรุปสำหรับลูกค้า (ภาษาไทย, 3-5 บรรทัด)
   - 2. เป้าหมายธุรกิจ
   - 3. ผู้ใช้งานหลัก (persona)
   - 4. User stories (As a ..., I want ..., So that ...)
   - 5. Functional requirements (FR-01, FR-02, ...)
   - 6. Non-functional requirements (performance, security, PDPA, backup, uptime)
   - 7. Scope in / Scope out
   - 8. Acceptance criteria (Given/When/Then)
   - 9. Open questions
   - 10. Assumptions
3. ถ้าข้อมูลไม่พอ ให้ทำเป็น "Open questions" อย่าเดา

## ภาษา

- สรุปสำหรับลูกค้า: ภาษาไทย
- technical spec: ภาษาอังกฤษหรือไทยตามที่ลูกค้าใช้
- ใช้คำศัพท์ dev แบบไทยเข้าใจได้ เช่น API, endpoint, database, backup

## ห้าม

- ห้ามใส่ข้อมูลลูกค้าจริง
- ห้ามสัญญา uptime/cost ที่ไม่ได้ยืนยัน
- ห้ามแอบอ้างว่าได้ทดสอบแล้วถ้ายังไม่ทดสอบ

## ตัวอย่าง prompt

"นี่คือโน้ตจากลูกค้า: ... ช่วยทำ PRD ตาม thai-prd โดยแยก unknowns ชัดเจน และให้ acceptance criteria ที่ test ได้"