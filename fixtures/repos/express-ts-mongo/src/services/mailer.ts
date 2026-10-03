import nodemailer from "nodemailer";

const transport = nodemailer.createTransport({ host: "smtp.example.com", port: 587 });

export async function sendMail(order: unknown) {
  await transport.sendMail({ to: "customer@example.com", subject: "Your order", text: JSON.stringify(order) });
}
