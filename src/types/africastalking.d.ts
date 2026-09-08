// The `africastalking` npm package ships no TypeScript declarations of its
// own — this covers only the tiny surface src/lib/sms.ts actually uses.
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

  interface AfricasTalkingClient {
    SMS: SmsClient;
  }

  function AfricasTalking(options: AfricasTalkingOptions): AfricasTalkingClient;
  export default AfricasTalking;
}
