# thai-quotation: ใบเสนอราคา / scope / timeline

## เป้าหมาย

ช่วยทำใบเสนอราคาและ scope สำหรับฟรีแลนซ์/นักพัฒนาไทย โดยไม่ให้สัญญาเกินจริง และแยกงานที่ไม่รวมอย่างชัดเจน

## โครงสร้าง

1. สรุปงาน (ภาษาไทย)
2. ขอบเขตงาน (Scope)
   - In scope
   - Out of scope
3. รายการงาน (milestones)
   - Milestone 1: ...
   - Milestone 2: ...
4. Timeline (วันเริ่ม/วันส่ง/ dependencies)
5. ค่าใช้จ่าย
   - ค่าพัฒนา
   - ค่า third-party / hosting / domain (ถ้ามี)
   - ค่า maintenance (ถ้ามี)
6. เงื่อนไข
   - payment schedule
   - change request policy
   - warranty / support period
7. Assumptions
8. Risks
9. Open questions

## กฎ

- ห้ามตั้งราคาต่ำจนไม่สมจริงเพื่อ "ชนะ"
- ห้ามสัญญา "เสร็จแน่นอน X วัน" ถ้ามี dependency จากลูกค้า
- ถ้าไม่รู้ราคา hosting/API ให้ใส่เป็น "estimate pending"
- แยก "งานที่รวม" และ "งานที่ไม่รวม" ให้ชัด

## ข้อควรระวังด้านภาษี/บัญชี

- เอกสารนี้ไม่ใช่คำแนะนำภาษี/บัญชี
- ผู้ใช้ต้องตรวจสอบ VAT/withholding tax/ใบกำกับภาษีกับผู้ทำบัญชีจริง

## ตัวอย่าง prompt

"นี่คือ scope ที่คุยกับลูกค้า: ... ช่วยทำ quotation ตาม thai-quotation โดยมี milestones, change request policy และ списокงานที่ไม่รวม"