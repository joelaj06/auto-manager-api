export interface IMailer {
  sendEmail(email: string, subject: string, text: string): Promise<void>;
}
