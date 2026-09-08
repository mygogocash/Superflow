import type { Messages } from "./en";

// Thai catalog. Typed as `Messages`, so it must stay key-for-key complete with
// the English source or the build fails.
export const th: Messages = {
  common: {
    save: "บันทึก",
    cancel: "ยกเลิก",
    delete: "ลบ",
    edit: "แก้ไข",
    close: "ปิด",
    loading: "กำลังโหลด…",
    search: "ค้นหา",
    confirm: "ยืนยัน",
    back: "ย้อนกลับ",
    next: "ถัดไป",
    submit: "ส่ง",
    saving: "กำลังบันทึก…",
  },
  language: {
    label: "ภาษา",
    english: "อังกฤษ",
    thai: "ไทย",
    switchTo: "เปลี่ยนภาษา",
  },
  auth: {
    signIn: "เข้าสู่ระบบ",
    signInSubtitle: "กรอกข้อมูลเพื่อเข้าใช้งานพอร์ทัล",
    signingIn: "กำลังเข้าสู่ระบบ…",
    email: "อีเมล",
    password: "รหัสผ่าน",
    emailPlaceholder: "you@manut.xyz",
    passwordPlaceholder: "กรอกรหัสผ่านของคุณ",
    forgotPassword: "ลืมรหัสผ่าน?",
    emailRequired: "กรุณากรอกอีเมล",
    emailInvalid: "กรุณากรอกอีเมลให้ถูกต้อง",
    passwordRequired: "กรุณากรอกรหัสผ่าน",
    passwordMin: "รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร",
    loginFailed: "เข้าสู่ระบบไม่สำเร็จ",
  },
};
