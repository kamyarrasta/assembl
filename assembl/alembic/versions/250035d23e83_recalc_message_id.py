"""recalc message_id

Revision ID: 250035d23e83
Revises: 53875f39d2ff
Create Date: 2015-12-12 15:07:06.294468

"""

# revision identifiers, used by Alembic.
revision = '250035d23e83'
down_revision = '53875f39d2ff'

from alembic import context, op
import sqlalchemy as sa
import transaction
from pyisemail import is_email


from assembl.lib import config


def upgrade(pyramid_env):
    # quick wins: emails and assembl.
    with context.begin_transaction():
        op.execute("""UPDATE post
            SET message_id = substring(message_id, 2, length(message_id)-2)
            WHERE message_id LIKE '<%>'""")
        op.execute("""UPDATE email
            SET in_reply_to = substring(in_reply_to, 2, length(in_reply_to)-2)
            WHERE in_reply_to LIKE '<%>'""")
        op.execute("""UPDATE post
            SET message_id = concat(
                substring(message_id, 10, length(message_id)), '_assembl@%s')
            WHERE message_id LIKE 'urn:uuid:%%'""" % (
                config.get('public_hostname'),))

    # Do stuff with the app's models here.
    from assembl import models as m
    db = m.get_session_maker()()

    with transaction.manager:
        for id, email in db.execute("SELECT id, message_id FROM post"):
            if is_email(email):
                continue
            c = m.Content.get(id)
            if isinstance(c, m.ImportedPost):
                c.message_id = c.source.generate_message_id(c.source_post_id)
            else:
                c.message_id = c.generate_message_id()


def downgrade(pyramid_env):
    pass