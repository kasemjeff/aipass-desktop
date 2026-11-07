# thai-github-issue: triage GitHub issue / bug report

## เป้าหมาย

ช่วยจัด issue ให้ actionable และไม่ซ้ำซ้อน

## โครงสร้าง

1. Summary
2. Reproduction steps
3. Expected behavior
4. Actual behavior
5. Environment
6. Severity
7. Labels
8. Owner / next action
9. Related issues

## กฎ

- แยก bug vs feature request
- อย่า assume root cause โดยไม่มีหลักฐาน
- ถ้า reproduce ไม่ได้ ให้ระบุ
- ถ้าเป็น security issue ให้ใช้ private advisory

## ตัวอย่าง prompt

"นี่คือ issue ที่ได้: ... ช่วย triage ตาม thai-github-issue และแนะนำ labels/severity"