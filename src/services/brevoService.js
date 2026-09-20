/**
 * Brevo Email Service
 * Sends transactional emails via Brevo API
 */

const BREVO_API_URL = 'https://api.brevo.com/v3';

/**
 * Send email via Brevo API
 * @param {object} options - Email options
 * @param {string} options.to - Recipient email
 * @param {string} options.subject - Email subject
 * @param {string} options.html - HTML content
 * @param {string} options.text - Plain text content
 */
async function sendEmail({ to, subject, html, text }) {
  const apiKey = process.env.BREVO_API_KEY;

  if (!apiKey) {
    // Local fallback: no Brevo key configured, so print the email
    // (which contains the OTP) to the server log instead of failing.
    // Works in any env (development, test, local) so the app is 100% local
    // without remote API keys. Production with a key still sends via API.
    console.log('[dev] Email not sent (BREVO_API_KEY missing). Contents:\n' + (text || ''));
    return { dev: true };
  }

  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  const senderName = process.env.BREVO_SENDER_NAME || 'VoteWeb';

  console.log('Attempting to send email via Brevo:', { to, subject, senderEmail });

  const response = await fetch(`${BREVO_API_URL}/smtp/email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify({
      sender: {
        name: senderName,
        email: senderEmail,
      },
      to: [{ email: to }],
      subject,
      htmlContent: html,
      textContent: text,
    }),
  });

  const responseBody = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error('Brevo API error:', { status: response.status, body: responseBody });
    // Development fallback: an invalid/expired Brevo key should not block
    // local testing. The email contents (including the OTP) are printed to
    // the server log instead. Production still fails loudly.
    if (process.env.NODE_ENV === 'development') {
      console.log('[dev] Email not sent (Brevo API error). Contents:\n' + (text || ''));
      return { dev: true };
    }
    throw new Error(`Brevo API error: ${responseBody.message || response.statusText}`);
  }

  console.log('Brevo email sent successfully:', { to, messageId: responseBody.messageId });
  return responseBody;
}

/**
 * Send login OTP email
 * @param {string} to - Recipient email
 * @param {string} otp - 6-digit OTP
 */
async function sendLoginOtp(to, otp) {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 28px;">VoteWeb</h1>
  </div>
  <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px;">
    <h2 style="color: #333; margin-top: 0;">Your Verification Code</h2>
    <div style="background: white; padding: 25px; text-align: center; border-radius: 8px; margin: 20px 0; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
      <p style="font-size: 14px; color: #666; margin: 0 0 10px 0;">Enter this code to sign in:</p>
      <p style="font-size: 42px; font-weight: bold; letter-spacing: 8px; color: #667eea; margin: 0;">${otp}</p>
    </div>
    <p style="font-size: 14px; color: #666;">This code expires in <strong>5 minutes</strong>.</p>
    <div style="background: #fff3cd; border: 1px solid #ffc107; padding: 15px; border-radius: 8px; margin-top: 20px;">
      <p style="margin: 0; font-size: 13px; color: #856404;">
        <strong>Security Notice:</strong> If you did not request this code, you can safely ignore this email. Your account remains secure.
      </p>
    </div>
  </div>
</body>
</html>`;

  const text = `
VoteWeb - Your Verification Code

Your verification code is: ${otp}

This code expires in 5 minutes.

If you did not request this code, you can safely ignore this email. Your account remains secure.
`;

  await sendEmail({
    to,
    subject: 'VoteWeb - Your Verification Code',
    html,
    text,
  });
}

/**
 * Send password reset OTP email
 * @param {string} to - Recipient email
 * @param {string} otp - 6-digit OTP
 */
async function sendPasswordResetOtp(to, otp) {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #e74c3c 0%, #c0392b 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 28px;">VoteWeb</h1>
  </div>
  <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px;">
    <h2 style="color: #333; margin-top: 0;">Password Reset Request</h2>
    <p style="color: #666;">We received a request to reset your VoteWeb account password.</p>
    <div style="background: white; padding: 25px; text-align: center; border-radius: 8px; margin: 20px 0; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
      <p style="font-size: 14px; color: #666; margin: 0 0 10px 0;">Your password reset code:</p>
      <p style="font-size: 42px; font-weight: bold; letter-spacing: 8px; color: #e74c3c; margin: 0;">${otp}</p>
    </div>
    <p style="font-size: 14px; color: #666;">This code expires in <strong>5 minutes</strong>.</p>
    <div style="background: #f8d7da; border: 1px solid #f5c6cb; padding: 15px; border-radius: 8px; margin-top: 20px;">
      <p style="margin: 0; font-size: 13px; color: #721c24;">
        <strong>Important:</strong> If you did not request a password reset, please ignore this email. Your current password remains valid and your account is secure.
      </p>
    </div>
  </div>
</body>
</html>`;

  const text = `
VoteWeb - Password Reset Request

We received a request to reset your VoteWeb account password.

Your password reset code is: ${otp}

This code expires in 5 minutes.

If you did not request a password reset, please ignore this email. Your current password remains valid.
`;

  await sendEmail({
    to,
    subject: 'VoteWeb - Password Reset Code',
    html,
    text,
  });
}

module.exports = {
  sendEmail,
  sendLoginOtp,
  sendPasswordResetOtp,
};
