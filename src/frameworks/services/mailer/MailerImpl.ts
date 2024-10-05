import { IMailer } from "./IMailer";
import nodemailer from "nodemailer";
import config from "../../../config/config";
import { injectable } from "inversify";

@injectable()
export class MailerImpl implements IMailer {
  async sendEmail(email: string, subject: string, text: string): Promise<void> {
    // create reusable transporter object using the default SMTP transport
    const transporter = nodemailer.createTransport({
      host: config.mailerHost,
      port: config.mailerPort,
      secure: true,
      auth: {
        user: config.mailerEmail,
        pass: config.mailerAppPassword,
      },
    });

    const mailOptions = {
      from: "Auto Manager",
      to: email,
      subject: subject,
      html: text,
    };

    try {
      const info = await transporter.sendMail(mailOptions);
      console.info("Email sent: " + info.response);
    } catch (error) {
      console.error(error);
      throw error; // rethrow the error to propagate the rejection
    }
  }
}
