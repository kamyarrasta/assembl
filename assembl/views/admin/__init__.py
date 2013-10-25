import transaction

from pyramid.view import view_config
from pyramid.renderers import render_to_response
from pyramid.security import authenticated_userid
from pyramid.httpexceptions import HTTPFound

from assembl.synthesis.models import Discussion
from assembl.views.home.views import get_default_context
from assembl.source.models.mail import Mailbox, MailingList
from assembl.auth.models import create_default_permissions, User


@view_config(route_name='discussion_admin')
def discussion_admin(request):
    user_id = authenticated_userid(request)

    if not user_id:
        return HTTPFound('/login?next_view=/admin/discussions/')

    session = User.db
    user = session.query(User).filter_by(id=user_id).one()
        
    context = get_default_context()
    context['discussions'] = session.query(Discussion)

    if request.method == 'POST':

        g = lambda x: request.POST.get(x, None)

        (topic, slug, name, host, port,
         ssl, folder, password, username) = (
            g('topic'),
            g('slug'),
            g('mbox_name'),
            g('host'),
            g('port'),
            True if g('ssl') == 'on' else False,
            g('folder'),
            g('password'),
            g('username'),
            )

        discussion = Discussion(
            topic=topic,
            slug=slug,
            owner=user,
            )

        session.add(discussion)

        create_default_permissions(session, discussion)
        mailbox_class = MailingList if g('mailing_list_address') else Mailbox
        mailbox = mailbox_class(
            name=name,
            host=host,
            port=int(port),
            username=username,
            use_ssl=ssl,
            folder=folder,
            password=password,
            )

        if(g('mailing_list_address')):
            mailbox.post_email_address = g('mailing_list_address')
        mailbox.discussion = discussion
        transaction.commit()


    return render_to_response(
        'admin/discussions.jinja2',
        context,
        request=request)


