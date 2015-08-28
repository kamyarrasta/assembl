This is for Ubuntu, but Borg is cross-platform

Installing Borg Backup
----------------------
Installing an up to date Borg Backup (https://borgbackup.github.io/borgbackup/)
Ubuntu:
sudo apt-get install python3-pip libacl1-dev
sudo pip3 install borgbackup

Using
-----
The script is in doc/borg_backup_script/assembl_borg_backup.sh

It assumes:
- borgbackup is installed on both the assembl server and the backup server
- The user running the script has access over ssh to the backup server with key authentication (no passphrase).  Typically, this will be the www-data user.

The script takes two environment variables:

ASSEMBL_PATH: the path to the assembl installation to backup
REPOSITORY: the address of the borg backup repository to backup to

You can the automate with cron.  For example:
sudo su - www-data
crontab -e
0 3 * * * ASSEMBL_PATH=/home/benoitg/development/assembl REPOSITORY=www-data@discussions.bluenove.com:/home/backups/assembl_backups.borg bash doc/borg_backup_script/assembl_borg_backup.sh > /tmp/assembl_backup.log


All backups are encrypted.  Make SURE you backup the keys (normally in ~/.borg/keys/) somewhere safe, otherwise your backups will be uselese

To secure the user, use an extemely restricted permission in 

# Allow an SSH keypair to only run |project_name|, and only have access to /media/backup.
# This will help to secure an automated remote backup system.
$ cat ~/.ssh/authorized_keys
command="borg serve --restrict-to-path /media/backup" ssh-rsa AAAAB3[...]

Restoring
---------
TODO