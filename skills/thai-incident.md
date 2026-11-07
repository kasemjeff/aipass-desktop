# thai-incident: รายงานปัญหา / incident postmortem

## เป้าหมาย

ช่วยเขียน incident report ที่ blameless, ชัดเจน, และมี action items

## โครงสร้าง

1. Summary
2. Impact
3. Timeline
4. Root cause
5. Detection
6. Resolution
7. What went well
8. What went wrong
9. Action items (owner + due date)
10. Prevention

## กฎ

- Blameless: โฟกัสที่ระบบ/กระบวนการ ไม่ใช่บุคคล
- Timeline ต้องมีเวลาจริง
- Action items ต้องมี owner และ due date
- อย่าสรุป root cause เกินหลักฐาน

## ตัวอย่าง prompt

"นี่คือ log/timeline ปัญหา: ... ช่วยทำ incident postmortem ตาม thai-incident แบบ blameless"