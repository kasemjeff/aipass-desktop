// คำนวณดอกเบี้ยแบบรายปี (simple interest)
export const interest = (capital, rate, years) => capital * rate * years;

// คำนวณภาษีมูลค่าเพิ่ม (VAT 7%)
export const vat = (price) => price * 0.07;
