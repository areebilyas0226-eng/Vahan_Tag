import twilio from "twilio";

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

export async function sendSMS(to, message) {
  return client.messages.create({
    body: message,
    from: process.env.TWILIO_PHONE,
    to
  });
}