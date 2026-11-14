import { useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Badge, Button, Card, Modal } from '../components/ui.tsx'

const Rule = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="practice-rule">
    <h3>{title}</h3>
    <div className="muted">{children}</div>
  </div>
)

const Step = ({ index, title, children }: { index: number; title: string; children: ReactNode }) => (
  <li className="practice-step">
    <span className="practice-index">{index}</span>
    <div className="stack gap-xs">
      <strong>{title}</strong>
      <div className="muted">{children}</div>
    </div>
  </li>
)

const Command = ({ children }: { children: string }) => <pre className="practice-command mono">{children}</pre>

const TryGpg = () => {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        Try it yourself
      </Button>
      <Modal open={open} title="Try gpg on your own machine" onClose={() => setOpen(false)}>
        <div className="stack gap-sm">
          <p className="muted small">
            Practice run with made up words, never real seeds. On a Mac: <span className="mono">brew install gnupg</span> if gpg
            is missing.
          </p>
          <Command>{`cd /tmp
echo "wallet a: apple river stone cloud" > test.txt

openssl rand -base64 24
# copy the output, that is your passphrase

gpg --symmetric --armor --cipher-algo AES256 -o test.asc test.txt
# paste the passphrase twice

cat test.asc
rm test.txt

gpg --decrypt test.asc`}</Command>
          <p className="muted small">
            gpg caches the passphrase for a few minutes. Run <span className="mono">gpgconf --kill gpg-agent</span> before decrypting
            to be asked again, and try a wrong passphrase to see it fail.
          </p>
        </div>
      </Modal>
    </>
  )
}

const signerSetup: { signer: string; backup: string; tone: 'good' | 'accent' | 'neutral'; status: string }[] = [
  { signer: 'Hardware wallet', backup: 'Seed in encrypted file A', tone: 'good', status: 'backed up' },
  { signer: 'Card wallet', backup: 'No seed: a linked backup card kept at another address', tone: 'accent', status: 'no seed' },
  { signer: 'Mobile wallet', backup: 'Own seed in encrypted file B, with its own passphrase', tone: 'good', status: 'backed up' },
  { signer: 'Browser wallet', backup: 'Own seed, never shared with another signer. Lose it and the others swap it out', tone: 'neutral', status: 'replaceable' },
  { signer: 'Spare device', backup: 'Kept at another address, only used for recovery', tone: 'neutral', status: 'off site' },
]

const checklist = [
  'Every signer of every Safe opens and can sign',
  'Every backup is where the location note says it is',
  'Encrypted blobs still download from at least two places',
  'Each blob decrypts on the offline machine',
  'Password manager entries still hold the passwords',
  'No Safe has two signers that share a backup, password or account',
  'If every device burned today, at least threshold many signers can be rebuilt from backups in other places',
]

const TABS = { signers: 'Safes & signers', backups: 'Seed backups' } as const
type Tab = keyof typeof TABS

const SignersTab = () => (
  <>
    <Card title="Ground rules" subtitle="One test for every decision: no single breach hands over enough signers to sign, and no single loss leaves too few.">
      <div className="practice-rules">
        <Rule title="The Safe is the backup">
          In a 3 of 5 Safe, losing up to two signers costs nothing: the remaining three swap them out. Keep funds in the Safe and
          treat signers as replaceable.
        </Rule>
        <Rule title="Fewer seeds">
          Seeds are not signers: card wallets like Tangem have no seed, and one seed derives unlimited accounts. Back up only
          what disaster recovery needs: at least threshold many signers you can rebuild without the devices.
        </Rule>
        <Rule title="Separate everything">
          Two signers of the same Safe never share a seed, password, password manager, email account or hiding place.
        </Rule>
        <Rule title="Hot wallets stay small">
          Browser and phone wallets hold spending money only. Anything that matters lives in the Safe.
        </Rule>
      </div>
    </Card>

    <Card title="Example signer setup" subtitle="An example: five signers, threshold 3, and at least three that can be rebuilt without the devices in daily use.">
      <div className="practice-table">
        {signerSetup.map((row) => (
          <div key={row.signer} className="practice-row">
            <strong>{row.signer}</strong>
            <span className="muted">{row.backup}</span>
            <Badge tone={row.tone}>{row.status}</Badge>
          </div>
        ))}
      </div>
    </Card>

    <Card title="Using Lokhus" subtitle="Habits for every transaction, so a quiet month does not turn into a costly mistake.">
      <ul className="practice-list">
        <li>Check recipient and amount on the hardware wallet screen, not only in the app</li>
        <li>Send a small test amount before the first large transfer to a new address</li>
        <li>Never copy an address from Activity: poisoners send zero value transfers from look alike addresses</li>
        <li>Only whitelist tokens you verified on the chain explorer</li>
        <li>Executing from a Ledger needs Blind signing on; turn it off again afterwards</li>
        <li>Write a note on every Safe and unusual transaction: what it is for, who signs, what comes next</li>
        <li>Review owners and threshold on each Safe page after any signer change</li>
        <li>Back up data/app.db now and then: it holds names, notes and pending signatures, not keys</li>
      </ul>
    </Card>

  </>
)

const BackupsTab = () => (
  <>
    <Card
      title="Encrypted seed backup"
      actions={<TryGpg />}
      subtitle="For seeds you do want backed up digitally. The blob can live anywhere online; the passphrase is what protects it."
    >
      <div className="practice-parts">
        <div className="practice-part">
          <span className="badge badge-warn">secret</span>
          <strong>Passphrase</strong>
          <span className="muted small">A long random string you generate. gpg asks for it when encrypting. Lives in a password manager.</span>
        </div>
        <div className="practice-part">
          <span className="badge badge-good">not secret</span>
          <strong>Encrypted file</strong>
          <span className="muted small">
            What gpg makes from your seeds plus the passphrase. Useless without the passphrase, so it can sit anywhere online.
          </span>
        </div>
      </div>
      <p className="muted small">gpg is the program, not the file. You need both the file and the passphrase to get the words back.</p>
      <ol className="practice-steps">
        <Step index={1} title="Use a machine that never goes online">
          A second hand Intel laptop (Tails does not run on Apple Silicon) booting Tails from USB with wifi off, or a Raspberry Pi
          that never joins a network. Not a VM on your daily Mac. gpg ships with Tails.
        </Step>
        <Step index={2} title="Generate one random passphrase per file">
          At least 128 bits, for example 10 random diceware words or a long generated string. Never reuse it for another file. Save
          it in a password manager.
        </Step>
        <Step index={3} title="Type the seeds into a text file">
          On the offline machine only, one labelled line per seed. One file must hold fewer seeds than the threshold: in a 3 of 5,
          at most two per file, so one leaked file plus passphrase can never sign. Use a separate passphrase per file.
          <Command>{'seeds.txt\nwallet a: apple river ... (24 words)\nwallet b: stone cloud ... (24 words)'}</Command>
        </Step>
        <Step index={4} title="Encrypt, then delete the plaintext">
          gpg asks for the passphrase twice. --armor makes the output plain text you can paste into email or notes.
          <Command>{'gpg --symmetric --armor --cipher-algo AES256 -o seeds.asc seeds.txt\nrm seeds.txt'}</Command>
          The result looks like this. Copy it to a USB stick and shut down; Tails forgets everything on shutdown.
          <Command>{'-----BEGIN PGP MESSAGE-----\njA0ECQMC...\n-----END PGP MESSAGE-----'}</Command>
        </Step>
        <Step index={5} title="Spread the encrypted file">
          Upload it to two or three places (cloud drives, a USB stick in a drawer). Give it a boring filename, not “seed” or “wallet”.
        </Step>
        <Step index={6} title="Keep the passphrase apart from the file">
          Never in the same account or email as the file. Different files go to different managers. Add one line saying which tool
          was used, for example “gpg symmetric”.
        </Step>
        <Step index={7} title="Recover">
          Download the file on your normal computer onto a USB stick and carry it to the offline machine. Decrypt there, enter the
          passphrase, and the words come back. gpg is an open standard, so any fresh Tails or Linux install can do this in ten years.
          <Command>{'gpg -d seeds.asc'}</Command>
        </Step>
      </ol>
    </Card>

    <Card
      title="Raspberry Pi how to"
      subtitle="An offline machine for encrypting and decrypting seeds. Any Pi with 2 GB or more is plenty: gpg needs almost nothing."
    >
      <p className="practice-phase eyebrow">Once: prepare the Pi</p>
      <ol className="practice-steps">
        <Step index={1} title="Gather the parts">
          Raspberry Pi with power supply, a fresh microSD card, USB keyboard, HDMI screen and a dedicated USB stick for moving
          encrypted files. No ethernet cable, ever.
        </Step>
        <Step index={2} title="Flash Raspberry Pi OS with desktop">
          Use Raspberry Pi Imager on your normal computer. The desktop version mounts USB sticks for you. In the customisation
          screen set a user and password, leave wifi empty and SSH off.
        </Step>
        <Step index={3} title="Disable wifi and Bluetooth in hardware config">
          Before ejecting the card, open the boot partition (bootfs) on your computer and add these lines at the end of config.txt.
          <Command>{'dtoverlay=disable-wifi\ndtoverlay=disable-bt'}</Command>
        </Step>
        <Step index={4} title="First boot, then verify it is offline">
          Skip every wifi and update prompt in the setup wizard. Then open a terminal: no wlan0 may be listed, and gpg must answer.
          <Command>{'ip link\ngpg --version'}</Command>
        </Step>
      </ol>

      <p className="practice-phase eyebrow">Each time: encrypt</p>
      <ol className="practice-steps">
        <Step index={1} title="Work in memory only">
          /dev/shm is a tmpfs folder: files there live in RAM and vanish at power off, so the seeds never touch the SD card, where
          deleted files can often be recovered. Turning swap off keeps RAM from being paged to the card.
          <Command>{'sudo swapoff -a\ncd /dev/shm\ndf -h .   # first column must say tmpfs'}</Command>
        </Step>
        <Step index={2} title="Type the seeds with an editor">
          Use nano, never echo: echo would put the words in your shell history on the SD card. Save with Ctrl+O, quit with Ctrl+X.
          <Command>{'nano seeds.txt'}</Command>
        </Step>
        <Step index={3} title="Encrypt and check before you trust it">
          Enter the passphrase twice. Decrypt once to the screen and compare every word with the original.
          <Command>{'gpg --symmetric --armor --cipher-algo AES256 -o seeds.asc seeds.txt\ngpg --decrypt seeds.asc'}</Command>
        </Step>
        <Step index={4} title="Copy the encrypted file out and power off">
          Plug in the USB stick; it appears under /media. Copy only seeds.asc, then power off: RAM, the plaintext and the cached
          passphrase are gone.
          <Command>{'cp seeds.asc /media/$USER/*/\nsync\nsudo poweroff'}</Command>
        </Step>
      </ol>

      <p className="practice-phase eyebrow">When you need it: decrypt</p>
      <ol className="practice-steps">
        <Step index={1} title="Bring the file over">
          Download seeds.asc on your normal computer onto the USB stick, boot the Pi, run sudo swapoff -a, and copy it into memory.
          <Command>{'cd /dev/shm\ncp /media/$USER/*/seeds.asc .'}</Command>
        </Step>
        <Step index={2} title="Decrypt to the screen only">
          No -o flag, so the words are never written to a file. Read them off, restore the wallet, then power off.
          <Command>{'gpg --decrypt seeds.asc\nsudo poweroff'}</Command>
        </Step>
      </ol>

      <p className="muted small">
        Store the Pi, its SD card and the USB stick together and label them. Never connect this Pi to a network, not even for
        updates: it does not need them.
      </p>
    </Card>

    <div className="practice-split">
      <Card title="Protect the accounts that hold pieces">
        <ul className="practice-list">
          <li>Hardware key or authenticator app as 2FA, never SMS</li>
          <li>Do not store blobs in your main email: it can reset most other accounts</li>
          <li>Write down where backups are, never what they contain</li>
        </ul>
      </Card>
      <Card title="Never">
        <ul className="practice-list">
          <li>Type a seed into an online computer, phone or website</li>
          <li>Photograph a seed or keep it in notes, chat or this app</li>
          <li>Put threshold many seeds behind one passphrase</li>
          <li>Roll your own crypto: use gpg</li>
        </ul>
      </Card>
    </div>

    <Card title="Yearly check" subtitle="Backups you never touch get lost. Put a recurring reminder in your calendar.">
      <ul className="practice-checklist">
        {checklist.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </Card>
  </>
)

export const BestPractice = () => {
  const [params, setParams] = useSearchParams()
  const tab: Tab = params.get('tab') === 'backups' ? 'backups' : 'signers'

  return (
    <div className="stack gap-lg">
      <div className="hero">
        <div>
          <p className="eyebrow">Keys, backups, recovery</p>
          <h1>Best practice</h1>
        </div>
        <div className="row gap-sm">
          {(Object.keys(TABS) as Tab[]).map((key) => (
            <Button key={key} size="sm" variant={tab === key ? 'primary' : 'ghost'} onClick={() => setParams({ tab: key })}>
              {TABS[key]}
            </Button>
          ))}
        </div>
      </div>
      {tab === 'signers' ? <SignersTab /> : <BackupsTab />}
    </div>
  )
}
