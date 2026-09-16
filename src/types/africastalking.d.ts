// The `africastalking` npm package ships no TypeScript declarations of its
// own — this covers only the tiny surface src/lib/sms.ts and
// src/lib/whatsapp.ts actually use.
declare module "africastalking" {
  interface AfricasTalkingOptions {
    apiKey: string;
    username: string;
  }

  interface SmsSendParams {
    to: string[];
    message: string;
    from?: string;
  }

  interface SmsClient {
    send(params: SmsSendParams): Promise<unknown>;
  }

  // Only the plain-text-message shape of WhatsApp.sendMessage's payload is
  // declared here (see lib/whatsapp.js's Joi schema for the full set —
  // template/media/interactive-list/interactive-button bodies also exist,
  // unused by this project, see whatsapp.ts's own comment on why).
  interface WhatsAppSendParams {
    waNumber: string;
    phoneNumber: string;
    body: { message: string };
  }

  interface WhatsAppClient {
    sendMessage(params: WhatsAppSendParams): Promise<unknown>;
  }

  interface AfricasTalkingClient {
    SMS: SmsClient;
    WHATSAPP: WhatsAppClient;
  }

  function AfricasTalking(options: AfricasTalkingOptions): AfricasTalkingClient;
  export default AfricasTalking;
}
