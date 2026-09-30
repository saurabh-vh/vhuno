# VH UNO

Multiplayer UNO for your office or home network. One computer runs the game, everyone else plays in their phone or laptop browser. Up to 20 players per room, with bots to fill empty seats.

Nothing to install except Node.js, and no internet connection is needed while you play.

## 1. One-time setup (host computer only)

Install **Node.js** (the LTS version) from https://nodejs.org. Players who only join do not need anything; a browser is enough.

## 2. Start the server

- **Windows:** double-click `START-WINDOWS.bat`.
- **macOS / Linux:** run `./start.sh` in a terminal from this folder (or `node server.js`).

A window opens showing something like:

```
 On this computer:   http://localhost:3000
 Share on your LAN:
   http://192.168.1.24:3000    (Wi-Fi)
```

Keep that window open for as long as you are playing. Closing it ends every game.

**Windows Firewall:** the first time, Windows asks whether Node.js may use the network. Tick **Private networks** and click **Allow**. If you missed it, see Troubleshooting below.

## 3. Create a room and invite people

1. On the host computer, open `http://localhost:3000`, enter your name and click **Create a room**.
2. The lobby shows a 4-letter room code and an invite link such as `http://192.168.1.24:3000/?room=QXTB`. Click **Copy link** and send it on WhatsApp, Slack, etc.
3. Friends on the **same Wi-Fi or office network** open the link, type their name and tap **Join**. They can also open the plain address and pick the room from "Rooms on this network".
4. Add bots if you are short of players, adjust the settings, and click **Start game**.

If the host computer has more than one network (for example Wi-Fi and Ethernet), the lobby shows a picker. Choose the one your friends are connected to.

## How a session works

By default VH UNO plays **to the last player**:

- When you empty your hand you finish 1st, the next person out finishes 2nd, and so on. The round keeps going until only one player is left, and they come last.
- Once you've finished you watch the rest of the round from your seat (you can still catch someone who forgets to call UNO).
- The card you go out on still counts: Skip, Reverse and Draw Two still hit the next player. Going out on a Wild Draw Four can't be challenged; the next player just draws 4.
- Each round you get **1 point for every player you finish ahead of**. With 10 players, 1st gets 9 points and last gets 0.
- After every round you see that round's finishing order and the session totals. The trophy button shows the live standings at any time.
- The session winner has the most points. Ties go to whoever has more 1st places, then the better average place.
- Choose the session length in the lobby: a fixed 1, 3, 5 or 10 rounds, or "Until the host ends it", in which case the host gets an **End session** button after each round that shows everyone the final podium.

Prefer classic UNO? Set **Round ends** to "When the first player goes out (official)" and the game scores cards to a target instead, as described below.

## Rules

Card play follows the official rules:

- Match the top card by color, number or symbol, or play a Wild.
- If you can't (or don't want to) play, draw one card. If it fits you may play it right away, otherwise tap **Keep card**.
- **Skip** skips the next player, **Reverse** changes direction (acts as Skip with two players), **Draw Two** makes the next player draw 2 and lose their turn.
- **Wild Draw Four** may only be played when you have no card of the current color. The next player can accept (draw 4) or **challenge**: if the player bluffed, they draw 4 instead; if not, the challenger draws 6.
- Tap **UNO!** when you are about to go down to one card (before or right after playing your second-to-last card). If someone catches you before the next player acts, you draw 2.
- In official mode, a round ends when someone plays their last card. They score the points left in everyone else's hands: number cards at face value, Skip / Reverse / Draw Two 20, Wilds 50, and the first player to reach the target score wins.
- With more than 10 players a second deck is added automatically.

### Room settings (host only, in the lobby)

| Setting | Options |
|---|---|
| Max players | 2 to 20 |
| Round ends | When everyone has finished (ranked, default), or when the first player goes out (official) |
| Session length | Until the host ends it (default), 1, 3, 5 or 10 rounds (ranked mode) |
| Winning score | Single round, 100, 200, 300, 500 (official), 1000 (official mode) |
| Starting hand | 5, 7 (official), 10 cards |
| Decks | Auto, 1, 2 or 3 |
| Turn timer | Off, 15, 30, 45, 60 seconds (on timeout the player draws or passes automatically) |
| Wild Draw Four | Can be challenged (official), must have no matching color, or play anytime |

House rules you can switch on: **Stack draw cards** (+2 on +2/+4, +4 on +4, the next player takes the total), **Draw until you can play**, **Sevens and zeros** (7 swaps hands with a player you pick, 0 passes all hands along), and **Jump-in** (play an identical card out of turn).

### Handy details

- If someone's phone locks or the page reloads, they rejoin their seat automatically. After 10 seconds away, a bot plays their turns until they return.
- People who join mid-game watch until the next round, then they are dealt in.
- The host can kick players, hand host rights to someone else, and end the game early.
- Keyboard shortcuts on a laptop: **D** draw, **K** keep card, **U** UNO, **C** catch, **Enter** chat.

## Troubleshooting

**Friends can't open the link.**
Make sure they are on the same Wi-Fi as the host (not mobile data, not a guest network that isolates devices). Then check the firewall. On Windows: Start, search "Allow an app through Windows Firewall", click *Change settings*, find **Node.js JavaScript Runtime** and tick **Private**. Also make sure your Wi-Fi is set as a *Private* network, not *Public*. On macOS: System Settings, Network, Firewall, Options, allow incoming connections for `node`.

**"Port 3000 is already in use".**
Another program is using that port. Start on a different one: `node server.js 4000` (or on Windows, open a Command Prompt in this folder and run `START-WINDOWS.bat 4000`). Share the new address it prints.

**Testing many players on one computer.**
Browsers limit live connections per site to about 6 tabs. To test with more, use different browsers or an incognito window, or just add bots.

**The address changed.**
Your router may give the host computer a new IP address from time to time. Always share the address the server window prints when you start it.

## Files

- `server.js` - the game server and rules engine (plain Node.js, no dependencies).
- `public/index.html` - the game everyone plays in the browser.
- `public/fonts/` - fonts bundled so the game looks right without internet.
- `public/brand.jpg` - the picture used in the header, on the home screen, on card backs and as the browser tab icon. Replace it with any square image (same file name) to rebrand.
- `START-WINDOWS.bat`, `start.sh` - launchers.
