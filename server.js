import express from "express";
import { CommunicationIdentityClient } from "@azure/communication-identity";

const app = express();
const port = 3000;

const connectionString = process.env.ACS_CONNECTION_STRING;
const identityClient = new CommunicationIdentityClient(connectionString);

app.get("/token", async (req, res) => {
  try {
    const user = await identityClient.createUser();
    const { token, expiresOn } = await identityClient.getToken(user, ["voip"]);

    res.json({
      userId: user.communicationUserId,
      token,
      expiresOn
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.listen(port, () => console.log(`Token service running on http://localhost:${port}`));
