"""emails use profiles

Revision ID: 21cd60685f14
Revises: 4f44fb7f3d6a
Create Date: 2013-08-29 22:40:48.801998

"""

# revision identifiers, used by Alembic.
revision = '21cd60685f14'
down_revision = '4f44fb7f3d6a'

from alembic import context, op
import sqlalchemy as sa
import transaction
from email.utils import parseaddr, formataddr


from assembl import models as m
from assembl.lib import config
from assembl.lib.sqla import Base as SQLAlchemyBaseModel
from assembl.models import Email, EmailRecipient, EmailAccount

db = m.DBSession


def upgrade(pyramid_env):
    with context.begin_transaction():
        op.add_column('email', sa.Column(
            u'sender_id', sa.Integer, sa.ForeignKey('email_account.id')))
        op.create_table(
            'email_recipient',
            sa.Column('id', sa.Integer, primary_key=True),
            sa.Column('account_id', sa.Integer,
                      sa.ForeignKey('email_account.id')),
            sa.Column('email_id', sa.Integer,
                      sa.ForeignKey('email.id')),
            sa.Column('type', sa.String(10), default="To"))
    # Do stuff with the app's models here.
    SQLAlchemyBaseModel.metadata.bind = op.get_bind()
    with transaction.manager:
        for mail in db.query(Email).all():
            sender_name, sender_email = parseaddr(mail.legacy_sender)
            account = EmailAccount.get_or_make_profile(
                db, sender_email, sender_name)
            mail.sender = account
            rcpt_name, rcpt_email = parseaddr(mail.legacy_recipients)
            account = EmailAccount.get_or_make_profile(
                db, rcpt_email, rcpt_name)
            db.add(EmailRecipient(email=mail, account=account))

    with context.begin_transaction():
        op.drop_column('email', u'sender')
        op.drop_column('email', u'recipients')


def downgrade(pyramid_env):
    with context.begin_transaction():
        op.add_column('email', sa.Column(u'sender', sa.Unicode(1024)))
        op.add_column('email', sa.Column(u'recipients', sa.Unicode(1024)))
    SQLAlchemyBaseModel.metadata.bind = op.get_bind()
    with transaction.manager:
        for mail in db.query(Email).all():
            sender = mail.sender
            mail.legacy_sender = formataddr(
                (sender.profile.name, sender.email))
            recipients = []
            for r in mail.recipient_rels:
                rcpt = r.account
                recipients.append(formataddr((rcpt.profile.name, rcpt.email)))
            mail.legacy_recipients = ', '.join(recipients)
    with context.begin_transaction():
        op.drop_column('email', 'sender_id')
        op.drop_table('email_recipient')
