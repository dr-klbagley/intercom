-- Reply to one exact message in Apple Mail, from the account it arrived on (spec §14.1).
-- Only run after Kevin tapped Confirm in Intercom.
--   osascript mail_reply.applescript <message id (Envelope Index ROWID)> <body file> <sender|all> [draft]
-- With "check" as the 4th argument it only finds the message and reports its sender and subject
-- (nothing is created or sent).
on run argv
	if (count of argv) < 3 then error "Expected message id, body file, sender|all"
	set msgId to (item 1 of argv) as integer
	set bodyText to read (POSIX file (item 2 of argv)) as «class utf8»
	set replyAll to (item 3 of argv) is "all"
	set checkOnly to ((count of argv) > 3 and item 4 of argv is "check")
	tell application "Mail"
		set found to missing value
		repeat with acct in accounts
			try
				set found to (first message of (mailbox "INBOX" of acct) whose id is msgId)
				exit repeat
			end try
			try
				set found to (first message of (mailbox "[Gmail]/All Mail" of acct) whose id is msgId)
				exit repeat
			end try
		end repeat
		if found is missing value then error "Message " & msgId & " not found in Mail"
		if checkOnly then return "Found: " & (sender of found) & " / " & (subject of found)
		set r to reply found opening window false reply to all replyAll
		delay 0.5
		set quoted to content of r
		set content of r to bodyText & return & return & quoted
		send r
		return "Sent: " & subject of r
	end tell
end run
