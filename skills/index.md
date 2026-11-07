# ชุด playbook นักพัฒนาไทย (Thai Developer Delivery)

ชุดนี้ช่วยให้ agent ทำงาน "ก่อนและหลังเขียนโค้ด" ให้เสร็จเป็นชิ้นงานที่ส่งลูกค้าหรือทีมได้

- `thai-prd` — แปลงความต้องการลูกค้าเป็น PRD/SRS
- `thai-quotation` — ใบเสนอราคา/scope/time/cost
- `thai-client-status` — สรุปสถานะงานสำหรับลูกค้า
- `thai-release-notes` — release notes/changelog ภาษาไทย
- `thai-handover` — เอกสารส่งมอบ/runbook
- `thai-incident` — รายงานปัญหา/incident postmortem
- `thai-sop` — SOP/ขั้นตอนการทำงาน
- `thai-readme` — README สำหรับ repo Thai/EN
- `thai-invoice-checklist` — checklist ออกใบแจ้งหนี้/วางบิล (ไม่ใช่คำแนะนำภาษี)
- `thai-privacy-checklist` — checklist PDPA/ความลับก่อนส่ง prompt
- `thai-setup-doctor` — ตั้งค่า/ซ่อม AiPASS Desktop
- `thai-credit-guard` — คุมเครดิต/เลือกโมเดลให้คุ้ม
- `thai-waf-403` — วินิจฉัย 403 / edge refusal
- `thai-email` — อีเมลลูกค้า/ผู้มีส่วนได้ส่วนเสีย
- `thai-line-reply` — ตอบ LINE OA / แชทลูกค้า
- `thai-deploy-checklist` — deploy / rollback checklist
- `thai-kb-article` — บทความ knowledge base
- `thai-github-issue` — triage GitHub issue / bug report
- `thai-meeting-notes` — สรุปประชุม / action items

**ข้อควรระวัง:** ห้ามใส่ข้อมูลลูกค้าจริง, เลขบัตร ปชช., secret, token, หรือ source code ลับใน prompt. ถ้าไม่แน่ใจ ให้ใช้ข้อมูลสมมติหรือ redacted version.