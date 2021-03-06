# -*- coding:utf-8 -*-

import logging
import sys
from datetime import datetime, timedelta

import pytest
from pytest_localserver.http import WSGIServer
from pyramid import testing
from pyramid.paster import get_appsettings
from pyramid.threadlocal import manager
import transaction
from webtest import TestApp, TestRequest
from pkg_resources import get_distribution
import simplejson as json
from splinter import Browser
from sqlalchemy import inspect

import assembl
from assembl.lib.migration import bootstrap_db, bootstrap_db_data
from assembl.lib.sqla import get_typed_session_maker, set_session_maker_type
from assembl.lib.config import get_config
from assembl.tasks import configure as configure_tasks
from .utils import clear_rows, drop_tables
from assembl.auth import R_SYSADMIN, R_PARTICIPANT


def zopish_session_tween_factory(handler, registry):

    def zopish_session_tween(request):
        get_typed_session_maker(False).commit()
        set_session_maker_type(True)
        try:
            return handler(request)
        finally:
            set_session_maker_type(False)

    return zopish_session_tween


@pytest.fixture(scope="session")
def session_factory(request):
    # Get the zopeless session maker,
    # while the Webtest server will use the
    # default session maker, which is zopish.
    session_factory = get_typed_session_maker(False)

    def fin():
        print "finalizer session_factory"
        session_factory.remove()
    request.addfinalizer(fin)
    return session_factory


@pytest.fixture(scope="session")
def empty_db(request, session_factory):
    session = session_factory()
    drop_tables(get_config(), session)
    return session_factory


@pytest.fixture(scope="session")
def db_tables(request, empty_db):
    app_settings_file = request.config.getoption('test_settings_file')
    assert app_settings_file
    from ..conftest import engine
    bootstrap_db(app_settings_file, engine)
    transaction.commit()

    def fin():
        print "finalizer db_tables"
        session = empty_db()
        drop_tables(get_config(), session)
        transaction.commit()
    request.addfinalizer(fin)
    return empty_db  # session_factory


@pytest.fixture(scope="session")
def base_registry(request):
    from assembl.views.traversal import root_factory
    from pyramid.config import Configurator
    from zope.component import getGlobalSiteManager
    registry = getGlobalSiteManager()
    config = Configurator(registry)
    config.setup_registry(
        settings=get_config(), root_factory=root_factory)
    configure_tasks(registry, 'assembl')
    config.add_tween('assembl.tests.pytest_fixtures.zopish_session_tween_factory')
    return registry


class PyramidWebTestRequest(TestRequest):
    def __init__(self, *args, **kwargs):
        super(PyramidWebTestRequest, self).__init__(*args, **kwargs)
        manager.push({'request': self})

    def get_response(self, app, catch_exc_info=True):
        try:
            super(PyramidWebTestRequest, app).get_response(
                catch_exc_info=catch_exc_info)
        finally:
            manager.pop()

    # TODO: Find a way to change user here
    authenticated_userid = None


@pytest.fixture(scope="module")
def test_app_no_perm(request, base_registry, db_tables):
    global_config = {
        '__file__': request.config.getoption('test_settings_file'),
        'here': get_distribution('assembl').location
    }
    app = TestApp(assembl.main(
        global_config, nosecurity=True, **get_config()))
    app.PyramidWebTestRequest = PyramidWebTestRequest
    return app


@pytest.fixture(scope="module")
def test_webrequest(request, test_app_no_perm):
    req = PyramidWebTestRequest.blank('/', method="GET")

    def fin():
        # The request was not called
        manager.pop()
    request.addfinalizer(fin)
    return req


@pytest.fixture(scope="module")
def db_default_data(request, db_tables, base_registry):
    bootstrap_db_data(db_tables)
    #db_tables.commit()
    transaction.commit()

    def fin():
        print "finalizer db_default_data"
        session = db_tables()
        clear_rows(get_config(), session)
        transaction.commit()
        from assembl.models import Locale, LangString
        Locale.reset_cache()
        LangString.reset_cache()
    request.addfinalizer(fin)
    return db_tables  # session_factory


@pytest.fixture(scope="function")
def test_session(request, db_default_data):
    session = db_default_data()

    def fin():
        print "finalizer test_session"
        try:
            session.commit()
            #session.close()
        except Exception:
            session.rollback()
    request.addfinalizer(fin)
    return session


@pytest.fixture(scope="function")
def default_preferences(request, test_session):
    from assembl.models import Preferences
    prefs = Preferences.get_default_preferences()
    test_session.add(prefs)
    test_session.flush()

    def fin():
        print "finalizer default_preferences"
        test_session.delete(prefs)
        test_session.flush()
    request.addfinalizer(fin)
    return prefs


@pytest.fixture(scope="function")
def discussion(request, test_session, default_preferences):
    from assembl.models import Discussion
    d = Discussion(topic=u"Jack Layton", slug="jacklayton2",
                   subscribe_to_notifications_on_signup=False,
                   session=test_session)
    test_session.add(d)
    test_session.add(d.next_synthesis)
    test_session.add(d.root_idea)
    test_session.add(d.table_of_contents)
    test_session.flush()

    def fin():
        print "finalizer discussion"
        discussion = d
        if inspect(discussion).detached:
            # How did this happen?
            discussion = test_session.query(Discussion).get(d.id)
        test_session.delete(discussion.table_of_contents)
        test_session.delete(discussion.root_idea)
        test_session.delete(discussion.next_synthesis)
        preferences = discussion.preferences
        discussion.preferences = None
        test_session.delete(preferences)
        test_session.delete(discussion)
        test_session.flush()
    request.addfinalizer(fin)
    return d


@pytest.fixture(scope="function")
def discussion2(request, test_session):
    from assembl.models import Discussion
    d = Discussion(topic=u"Second discussion", slug="testdiscussion2")
    test_session.add(d)
    test_session.add(d.next_synthesis)
    test_session.add(d.root_idea)
    test_session.add(d.table_of_contents)
    test_session.flush()

    def fin():
        print "finalizer discussion2"
        test_session.delete(d.table_of_contents)
        test_session.delete(d.root_idea)
        test_session.delete(d.next_synthesis)
        preferences = d.preferences
        d.preferences = None
        test_session.delete(preferences)
        test_session.delete(d)
        test_session.flush()
    request.addfinalizer(fin)
    return d


@pytest.fixture(scope="function")
def admin_user(request, test_session, db_default_data):
    from assembl.models import User, UserRole, Role
    u = User(name=u"Mr. Administrator", type="user")
    test_session.add(u)
    r = Role.get_role(R_SYSADMIN, test_session)
    ur = UserRole(user=u, role=r)
    test_session.add(ur)
    test_session.flush()
    uid = u.id

    def fin():
        print "finalizer admin_user"
        # I often get expired objects here, and I need to figure out why
        user = test_session.query(User).get(uid)
        user_role = user.roles[0]
        test_session.delete(user_role)
        test_session.delete(user)
        test_session.flush()
    request.addfinalizer(fin)
    return u


@pytest.fixture(scope="function")
def test_adminuser_webrequest(request, admin_user, test_app_no_perm):
    req = PyramidWebTestRequest.blank('/', method="GET")
    req.authenticated_userid = admin_user.id

    def fin():
        # The request was not called
        manager.pop()
    request.addfinalizer(fin)
    return req


@pytest.fixture(scope="function")
def test_app(request, admin_user, test_app_no_perm):
    config = testing.setUp(
        registry=test_app_no_perm.app.registry,
        settings=get_config(),
    )
    dummy_policy = config.testing_securitypolicy(
        userid=admin_user.id, permissive=True)
    config.set_authorization_policy(dummy_policy)
    config.set_authentication_policy(dummy_policy)
    return test_app_no_perm


@pytest.fixture(scope="function")
def test_server(request, test_app):
    server = WSGIServer(application=test_app.app)
    server.start()
    request.addfinalizer(server.stop)
    return server


@pytest.fixture(scope="function")
def participant1_user(request, test_session, discussion):
    from assembl.models import User, UserRole, Role, EmailAccount
    u = User(name=u"A. Barking Loon", type="user", password="password", verified=True)
    email = EmailAccount(email="abloon@example.com", profile=u, verified=True)
    test_session.add(u)
    r = Role.get_role(R_PARTICIPANT, test_session)
    ur = UserRole(user=u, role=r)
    test_session.add(ur)
    u.subscribe(discussion)
    test_session.flush()

    def fin():
        print "finalizer participant1_user"
        test_session.delete(u)
        test_session.flush()
    request.addfinalizer(fin)
    return u


@pytest.fixture(scope="function")
def participant2_user(request, test_session):
    from assembl.models import User, UserRole, Role
    u = User(name=u"James T. Expert", type="user")
    test_session.add(u)
    r = Role.get_role(R_PARTICIPANT, test_session)
    ur = UserRole(user=u, role=r)
    test_session.add(ur)
    test_session.flush()

    def fin():
        print "finalizer participant2_user"
        test_session.delete(u)
        test_session.flush()
    request.addfinalizer(fin)
    return u


@pytest.fixture(scope="function")
def mailbox(request, discussion, test_session):
    from assembl.models import AbstractMailbox
    m = AbstractMailbox(
        discussion=discussion, name='mailbox')
    test_session.add(m)
    test_session.flush()

    def fin():
        print "finalizer mailbox"
        test_session.delete(m)
        test_session.flush()
    request.addfinalizer(fin)
    return m


@pytest.fixture(scope="function")
def jack_layton_mailbox(request, discussion, test_session):
    """ From https://dev.imaginationforpeople.org/redmine/projects/assembl/wiki/SampleDebate
    """
    import os
    from assembl.models import MaildirMailbox
    maildir_path = os.path.join(os.path.dirname(__file__),
                                'jack_layton_mail_fixtures_maildir')
    m = MaildirMailbox(discussion=discussion, name='Jack Layton fixture',
                       filesystem_path=maildir_path)
    m.do_import_content(m, only_new=True)
    test_session.add(m)
    test_session.flush()

    def fin():
        print "finalizer jack_layton_mailbox"
        agents = set()
        for post in m.contents:
            agents.add(post.creator)
            test_session.delete(post)
        for agent in agents:
            test_session.delete(agent)
        test_session.delete(m)
        test_session.flush()
    request.addfinalizer(fin)
    return m


@pytest.fixture(scope="function")
def abstract_mailbox(request, discussion, test_session):
    from assembl.models import AbstractMailbox
    ps = AbstractMailbox(
        discussion=discussion, name='a source', type='abstract_mailbox')
    test_session.add(ps)
    test_session.flush()

    def fin():
        print "finalizer abstract_mailbox"
        test_session.delete(ps)
        test_session.flush()
    request.addfinalizer(fin)
    return ps


@pytest.fixture(scope="function")
def root_post_1(request, participant1_user, discussion, test_session):
    """
    From participant1_user
    """
    from assembl.models import Post, LangString
    p = Post(
        discussion=discussion, creator=participant1_user,
        subject=LangString.create(u"a root post"),
        body=LangString.create(u"post body"), moderator=None,
        creation_date=datetime(year=2000, month=1, day=1),
        type="post", message_id="msg1@example.com")
    test_session.add(p)
    test_session.flush()

    def fin():
        print "finalizer root_post_1"
        test_session.delete(p)
        test_session.flush()
    request.addfinalizer(fin)
    return p


@pytest.fixture(scope="function")
def discussion2_root_post_1(request, participant1_user, discussion2, test_session):
    """
    From participant1_user
    """
    from assembl.models import Post, LangString
    p = Post(
        discussion=discussion2, creator=participant1_user,
        subject=LangString.create(u"a root post"),
        body=LangString.create(u"post body"),
        creation_date=datetime(year=2000, month=1, day=2),
        type="post", message_id="msg1@example2.com")
    test_session.add(p)
    test_session.flush()

    def fin():
        print "finalizer discussion2_root_post_1"
        test_session.delete(p)
        test_session.flush()
    request.addfinalizer(fin)
    return p


@pytest.fixture(scope="function")
def synthesis_post_1(request, participant1_user, discussion, test_session, synthesis_1):
    from assembl.models import SynthesisPost, LangString
    p = SynthesisPost(
        discussion=discussion, creator=participant1_user,
        subject=LangString.create(u"a synthesis post"),
        body=LangString.create(u"post body (unused, it's a synthesis...)"),
        message_id="msg1s@example.com",
        creation_date=datetime(year=2000, month=1, day=3),
        publishes_synthesis = synthesis_1)
    test_session.add(p)
    test_session.flush()

    def fin():
        print "finalizer synthesis_post_1"
        test_session.delete(p)
        test_session.flush()
    request.addfinalizer(fin)
    return p


@pytest.fixture(scope="function")
def reply_post_1(request, participant2_user, discussion,
                 root_post_1, test_session):
    """
    From participant2_user, in reply to root_post_1
    """
    from assembl.models import Post, LangString
    p = Post(
        discussion=discussion, creator=participant2_user,
        subject=LangString.create(u"re1: root post"),
        body=LangString.create(u"post body"),
        creation_date=datetime(year=2000, month=1, day=4),
        type="post", message_id="msg2@example.com")
    test_session.add(p)
    test_session.flush()
    p.set_parent(root_post_1)
    test_session.flush()

    def fin():
        print "finalizer reply_post_1"
        test_session.delete(p)
        test_session.flush()
    request.addfinalizer(fin)
    return p


@pytest.fixture(scope="function")
def reply_post_2(request, participant1_user, discussion,
                 reply_post_1, test_session):
    """
    From participant1_user, in reply to reply_post_1
    """
    from assembl.models import Post, LangString
    p = Post(
        discussion=discussion, creator=participant1_user,
        subject=LangString.create(u"re2: root post"),
        body=LangString.create(u"post body"),
        creation_date=datetime(year=2000, month=1, day=5),
        type="post", message_id="msg3@example.com")
    test_session.add(p)
    test_session.flush()
    p.set_parent(reply_post_1)
    test_session.flush()

    def fin():
        print "finalizer reply_post_2"
        test_session.delete(p)
        test_session.flush()
    request.addfinalizer(fin)
    return p


@pytest.fixture(scope="function")
def reply_post_3(request, participant2_user, discussion,
                 root_post_1, test_session):
    """
    From participant2_user, in reply to reply_post_2
    """
    from assembl.models import Post, LangString
    p = Post(
        discussion=discussion, creator=participant2_user,
        subject=LangString.create(u"re2: root post"),
        body=LangString.create(u"post body"),
        type="post", message_id="msg4@example.com")
    test_session.add(p)
    test_session.flush()
    p.set_parent(root_post_1)
    test_session.flush()

    def fin():
        print "finalizer reply_post_3"
        test_session.delete(p)
        test_session.flush()
    request.addfinalizer(fin)
    return p


@pytest.fixture(scope="function")
def root_idea(request, discussion, test_session):
    return discussion.root_idea


@pytest.fixture(scope="function")
def subidea_1(request, discussion, root_idea, test_session):
    from assembl.models import Idea, IdeaLink
    i = Idea(short_title="idea 1", discussion=discussion)
    test_session.add(i)
    l_r_1 = IdeaLink(source=root_idea, target=i)
    test_session.add(l_r_1)
    test_session.flush()

    def fin():
        print "finalizer subidea_1"
        test_session.delete(l_r_1)
        test_session.delete(i)
        test_session.flush()
    request.addfinalizer(fin)
    return i


@pytest.fixture(scope="function")
def subidea_1_1(request, discussion, subidea_1, test_session):
    from assembl.models import Idea, IdeaLink
    i = Idea(short_title="idea 1.1", discussion=discussion)
    test_session.add(i)
    l_1_11 = IdeaLink(source=subidea_1, target=i)
    test_session.add(l_1_11)
    test_session.flush()

    def fin():
        print "finalizer subidea_1_1"
        test_session.delete(l_1_11)
        test_session.delete(i)
        test_session.flush()
    request.addfinalizer(fin)
    return i


@pytest.fixture(scope="function")
def criterion_1(request, discussion, subidea_1, test_session):
    from assembl.models import Idea, IdeaLink
    i = Idea(short_title="cost", discussion=discussion)
    test_session.add(i)
    l_1_11 = IdeaLink(source=subidea_1, target=i)
    test_session.add(l_1_11)
    test_session.flush()

    def fin():
        print "finalizer criterion_1"
        test_session.delete(l_1_11)
        test_session.delete(i)
        test_session.flush()
    request.addfinalizer(fin)
    return i


@pytest.fixture(scope="function")
def criterion_2(request, discussion, subidea_1, test_session):
    from assembl.models import Idea, IdeaLink
    i = Idea(short_title="quality", discussion=discussion)
    test_session.add(i)
    l_1_11 = IdeaLink(source=subidea_1, target=i)
    test_session.add(l_1_11)
    test_session.flush()

    def fin():
        print "finalizer criterion_2"
        test_session.delete(l_1_11)
        test_session.delete(i)
        test_session.flush()
    request.addfinalizer(fin)
    return i


@pytest.fixture(scope="function")
def criterion_3(request, discussion, subidea_1, test_session):
    from assembl.models import Idea, IdeaLink
    i = Idea(short_title="time", discussion=discussion)
    test_session.add(i)
    l_1_11 = IdeaLink(source=subidea_1, target=i)
    test_session.add(l_1_11)
    test_session.flush()

    def fin():
        print "finalizer criterion_3"
        test_session.delete(l_1_11)
        test_session.delete(i)
        test_session.flush()
    request.addfinalizer(fin)
    return i


@pytest.fixture(scope="function")
def lickert_range(request, test_session):
    from assembl.models import LickertRange
    lr = LickertRange()
    test_session.add(lr)
    test_session.flush()

    def fin():
        print "finalizer lickert_range"
        test_session.delete(lr)
        test_session.flush()
    request.addfinalizer(fin)
    return lr


@pytest.fixture(scope="function")
def subidea_1_1_1(request, discussion, subidea_1_1, test_session):
    from assembl.models import Idea, IdeaLink
    i = Idea(short_title="idea 1.1.1", discussion=discussion)
    test_session.add(i)
    l_11_111 = IdeaLink(source=subidea_1_1, target=i)
    test_session.add(l_11_111)
    test_session.flush()

    def fin():
        print "finalizer subidea_1_1_1"
        test_session.delete(l_11_111)
        test_session.delete(i)
        test_session.flush()
    request.addfinalizer(fin)
    return i


@pytest.fixture(scope="function")
def synthesis_1(request, discussion, subidea_1, subidea_1_1, test_session):
    from assembl.models import Synthesis, SubGraphIdeaAssociation,\
        SubGraphIdeaLinkAssociation
    s = Synthesis(discussion=discussion)
    test_session.add(s)
    i1_a = SubGraphIdeaAssociation(sub_graph=s, idea=subidea_1)
    test_session.add(i1_a)
    i11_a = SubGraphIdeaAssociation(sub_graph=s, idea=subidea_1_1)
    test_session.add(i11_a)
    l_1_11 = subidea_1_1.source_links[0]
    l_1_11_a = SubGraphIdeaLinkAssociation(sub_graph=s, idea_link=l_1_11)
    test_session.add(l_1_11_a)
    test_session.flush()

    def fin():
        print "finalizer synthesis_1"
        test_session.delete(l_1_11_a)
        test_session.delete(i11_a)
        test_session.delete(i1_a)
        test_session.delete(s)
        test_session.flush()
    request.addfinalizer(fin)

    return s


@pytest.fixture(scope="function")
def extract_post_1_to_subidea_1_1(
        request, participant2_user, reply_post_1,
        subidea_1_1, discussion, test_session):
    """ Links reply_post_1 to subidea_1_1 """
    from assembl.models import Extract
    e = Extract(
        body=u"body",
        creator=participant2_user,
        owner=participant2_user,
        content=reply_post_1,
        idea_id=subidea_1_1.id,  # strange bug: Using idea directly fails
        discussion=discussion)
    test_session.add(e)
    test_session.flush()

    def fin():
        print "finalizer extract_post_1_to_subidea_1_1"
        test_session.delete(e)
        test_session.flush()
    request.addfinalizer(fin)
    return e


@pytest.fixture(scope="function")
def creativity_session_widget(
        request, test_session, discussion, subidea_1):
    from assembl.models import CreativitySessionWidget
    test_session.flush()
    c = CreativitySessionWidget(
        discussion=discussion,
        settings=json.dumps({
            'idea': subidea_1.uri(),
            'notifications': [
                {
                    'start': '2014-01-01T00:00:00',
                    'end': format(datetime.utcnow() + timedelta(1)),
                    'message': 'creativity_session'
                }
            ]}))
    test_session.add(c)

    def fin():
        print "finalizer creativity_session_widget"
        test_session.delete(c)
        test_session.flush()
    request.addfinalizer(fin)

    return c


@pytest.fixture(scope="function")
def creativity_session_widget_new_idea(
        request, test_session, discussion, subidea_1,
        creativity_session_widget, participant1_user):
    from assembl.models import (Idea, IdeaLink, GeneratedIdeaWidgetLink,
                                IdeaProposalPost, LangString)
    i = Idea(
        discussion=discussion,
        short_title="generated idea")
    test_session.add(i)
    l_1_wi = IdeaLink(source=subidea_1, target=i)
    test_session.add(l_1_wi)
    l_w_wi = GeneratedIdeaWidgetLink(
        widget=creativity_session_widget,
        idea=i)
    ipp = IdeaProposalPost(
        proposes_idea=i, creator=participant1_user, discussion=discussion,
        message_id='proposal@example.com',
        subject=LangString.create(u"propose idea"),
        body=LangString.EMPTY(test_session))
    test_session.add(ipp)

    def fin():
        print "finalizer creativity_session_widget_new_idea"
        test_session.delete(ipp)
        test_session.delete(l_w_wi)
        test_session.delete(l_1_wi)
        test_session.delete(i)
        test_session.flush()
    request.addfinalizer(fin)

    return i


@pytest.fixture(scope="function")
def creativity_session_widget_post(
        request, test_session, discussion, participant1_user,
        creativity_session_widget, creativity_session_widget_new_idea):
    from assembl.models import (Post, IdeaContentWidgetLink, LangString)
    p = Post(
        discussion=discussion, creator=participant1_user,
        subject=LangString.create(u"re: generated idea"),
        body=LangString.create(u"post body"),
        type="post", message_id="comment_generated@example.com")
    test_session.add(p)
    test_session.flush()
    icwl = IdeaContentWidgetLink(
        content=p, idea=creativity_session_widget_new_idea,
        creator=participant1_user)
    test_session.add(icwl)

    def fin():
        print "finalizer creativity_session_widget_post"
        test_session.delete(icwl)
        test_session.delete(p)
        test_session.flush()
    request.addfinalizer(fin)

    return p


@pytest.fixture(scope="module")
def virtualdisplay(request):
    from pyvirtualdisplay import Display
    display = Display(visible=0, size=(1024, 768))
    display.start()

    def fin():
        print "finalizer virtualdisplay"
        display.stop()
    request.addfinalizer(fin)

    return display


@pytest.fixture(scope="module")
def browser(request, virtualdisplay):
    browser = Browser()

    def fin():
        print "finalizer browser"
        browser.quit()
    request.addfinalizer(fin)

    return browser


@pytest.fixture(scope="function")
def en_ca_locale(request, test_session):
    from assembl.models.langstrings import Locale

    locale = Locale.get_or_create("en_CA", test_session)

    def fin():
        Locale.reset_cache()
        test_session.delete(locale)
        test_session.flush()

    request.addfinalizer(fin)
    return locale


@pytest.fixture(scope="function")
def en_locale(request, test_session):
    from assembl.models.langstrings import Locale
    locale = Locale.get_or_create("en", test_session)

    def fin():
        test_session.delete(locale)
        test_session.flush()
        Locale.reset_cache()

    request.addfinalizer(fin)
    return locale


@pytest.fixture(scope="function")
def fr_locale(request, test_session):
    from assembl.models.langstrings import Locale
    locale = Locale.get_or_create("fr", test_session)

    def fin():
        test_session.delete(locale)
        test_session.flush()
        Locale.reset_cache()

    request.addfinalizer(fin)
    return locale


@pytest.fixture(scope="function")
def it_locale(request, test_session):
    from assembl.models.langstrings import Locale
    locale = Locale.get_or_create("it", test_session)

    def fin():
        test_session.delete(locale)
        test_session.flush()
        Locale.reset_cache()

    request.addfinalizer(fin)
    return locale


@pytest.fixture(scope="function")
def de_locale(request, test_session):
    from assembl.models.langstrings import Locale

    locale = Locale.get_or_create("de", test_session)

    def fin():
        test_session.delete(locale)
        test_session.flush()
        Locale.reset_cache()

    request.addfinalizer(fin)
    return locale


@pytest.fixture(scope="function")
def tr_locale(request, test_session):
    from assembl.models.langstrings import Locale

    locale = Locale.get_or_create("tr", test_session)

    def fin():
        test_session.delete(locale)
        test_session.flush()
        Locale.reset_cache()

    request.addfinalizer(fin)
    return locale


@pytest.fixture(scope="function")
def non_linguistic_locale(request, test_session):
    from assembl.models.langstrings import Locale

    locale = Locale.get_or_create(Locale.NON_LINGUISTIC, test_session)

    def fin():
        test_session.delete(locale)
        test_session.flush()
        Locale.reset_cache()

    request.addfinalizer(fin)
    return locale


@pytest.fixture(scope="function")
def undefined_locale(request, test_session):
    from assembl.models.langstrings import Locale

    locale = Locale.get_or_create(Locale.UNDEFINED, test_session)

    def fin():
        test_session.delete(locale)
        test_session.flush()
        Locale.reset_cache()

    request.addfinalizer(fin)
    return locale


@pytest.fixture(scope="function")
def fr_from_en_locale(request, test_session, en_locale, fr_locale):

    from assembl.models.langstrings import Locale
    locale = Locale.create_mt_locale(en_locale, fr_locale, db=test_session)

    def fin():
        test_session.delete(locale)
        test_session.flush()
        Locale.reset_cache()

    request.addfinalizer(fin)
    return locale


@pytest.fixture(scope="function")
def en_from_fr_locale(request, test_session, en_locale, fr_locale):
    from assembl.models.langstrings import Locale

    locale = Locale.create_mt_locale(fr_locale, en_locale, db=test_session)

    def fin():
        test_session.delete(locale)
        test_session.flush()
        Locale.reset_cache()

    request.addfinalizer(fin)
    return locale


@pytest.fixture(scope="function")
def it_from_en_locale(request, test_session, en_locale, it_locale):

    from assembl.models.langstrings import Locale
    locale = Locale.create_mt_locale(en_locale, it_locale, db=test_session)

    def fin():
        test_session.delete(locale)
        test_session.flush()
        Locale.reset_cache()

    request.addfinalizer(fin)
    return locale


@pytest.fixture(scope="function")
def en_from_it_locale(request, test_session, en_locale, it_locale):
    from assembl.models.langstrings import Locale

    locale = Locale.create_mt_locale(it_locale, en_locale, db=test_session)

    def fin():
        test_session.delete(locale)
        test_session.flush()
        Locale.reset_cache()

    request.addfinalizer(fin)
    return locale


@pytest.fixture(scope="function")
def fr_from_it_locale(request, test_session, fr_locale, it_locale):

    from assembl.models.langstrings import Locale
    locale = Locale.create_mt_locale(it_locale, fr_locale, db=test_session)

    def fin():
        test_session.delete(locale)
        test_session.flush()
        Locale.reset_cache()

    request.addfinalizer(fin)
    return locale


@pytest.fixture(scope="function")
def it_from_fr_locale(request, test_session, fr_locale, it_locale):
    from assembl.models.langstrings import Locale

    locale = Locale.create_mt_locale(fr_locale, it_locale, db=test_session)

    def fin():
        test_session.delete(locale)
        test_session.flush()
        Locale.reset_cache()

    request.addfinalizer(fin)
    return locale


@pytest.fixture(scope="function")
def fr_from_und_locale(request, test_session, undefined_locale, fr_locale):

    from assembl.models.langstrings import Locale
    locale = Locale.create_mt_locale(undefined_locale, fr_locale,
                                     db=test_session)

    def fin():
        test_session.delete(locale)
        test_session.flush()
        Locale.reset_cache()

    request.addfinalizer(fin)
    return locale


@pytest.fixture(scope="function")
def de_from_en_locale(request, test_session, de_locale, en_locale):

    from assembl.models.langstrings import Locale
    locale = Locale.create_mt_locale(en_locale, de_locale,
                                     db=test_session)

    def fin():
        test_session.delete(locale)
        test_session.flush()
        Locale.reset_cache()

    request.addfinalizer(fin)
    return locale


@pytest.fixture(scope="function")
def de_from_tr_locale(request, test_session, de_locale, tr_locale):

    from assembl.models.langstrings import Locale
    locale = Locale.create_mt_locale(tr_locale, de_locale,
                                     db=test_session)

    def fin():
        test_session.delete(locale)
        test_session.flush()
        Locale.reset_cache()

    request.addfinalizer(fin)
    return locale


@pytest.fixture(scope="function")
def en_from_de_locale(request, test_session, de_locale, en_locale):

    from assembl.models.langstrings import Locale
    locale = Locale.create_mt_locale(de_locale, en_locale,
                                     db=test_session)

    def fin():
        test_session.delete(locale)
        test_session.flush()
        Locale.reset_cache()

    request.addfinalizer(fin)
    return locale


@pytest.fixture(scope="function")
def tr_from_en_locale(request, test_session, tr_locale, en_locale):

    from assembl.models.langstrings import Locale
    locale = Locale.create_mt_locale(en_locale, tr_locale,
                                     db=test_session)

    def fin():
        test_session.delete(locale)
        test_session.flush()
        Locale.reset_cache()

    request.addfinalizer(fin)
    return locale


@pytest.fixture(scope="function")
def en_from_tr_locale(request, test_session, tr_locale, en_locale):

    from assembl.models.langstrings import Locale
    locale = Locale.create_mt_locale(tr_locale, en_locale,
                                     db=test_session)

    def fin():
        test_session.delete(locale)
        test_session.flush()
        Locale.reset_cache()

    request.addfinalizer(fin)
    return locale


@pytest.fixture(scope="function")
def user_language_preference_en_cookie(request, test_session, en_locale,
                                       admin_user):

    from assembl.models.auth import (
        UserLanguagePreference,
        LanguagePreferenceOrder
    )

    locale_from = en_locale
    ulp = UserLanguagePreference(
        user=admin_user,
        locale=locale_from,
        preferred_order=0,
        source_of_evidence=LanguagePreferenceOrder.Cookie)

    def fin():
        print "finalizer user_language_preference_cookie"
        test_session.delete(ulp)
        test_session.flush()

    test_session.add(ulp)
    test_session.flush()
    request.addfinalizer(fin)
    return ulp


@pytest.fixture(scope="function")
def user_language_preference_fr_cookie(request, test_session, fr_locale,
                                       admin_user):

    from assembl.models.auth import (
        UserLanguagePreference,
        LanguagePreferenceOrder
    )

    locale_from = fr_locale
    ulp = UserLanguagePreference(
        user=admin_user,
        locale=locale_from,
        preferred_order=0,
        source_of_evidence=LanguagePreferenceOrder.Cookie)

    def fin():
        print "finalizer user_language_preference_cookie"
        test_session.delete(ulp)
        test_session.flush()

    test_session.add(ulp)
    test_session.flush()
    request.addfinalizer(fin)
    return ulp


@pytest.fixture(scope="function")
def user_language_preference_it_cookie(request, test_session, it_locale,
                                       admin_user):

    from assembl.models.auth import (
        UserLanguagePreference,
        LanguagePreferenceOrder
    )

    locale_from = it_locale
    ulp = UserLanguagePreference(
        user=admin_user,
        locale=locale_from,
        preferred_order=0,
        source_of_evidence=LanguagePreferenceOrder.Cookie)

    def fin():
        print "finalizer user_language_preference_cookie"
        test_session.delete(ulp)
        test_session.flush()

    test_session.add(ulp)
    test_session.flush()
    request.addfinalizer(fin)
    return ulp


@pytest.fixture(scope="function")
def user_language_preference_en_explicit(request, test_session, en_locale,
                                         admin_user):
    from assembl.models.auth import (
        UserLanguagePreference,
        LanguagePreferenceOrder
    )

    locale_from = en_locale
    ulp = UserLanguagePreference(
        user=admin_user,
        locale=locale_from,
        preferred_order=0,
        source_of_evidence=LanguagePreferenceOrder.Explicit)

    def fin():
        print "finalizer user_language_preference_cookie"
        test_session.delete(ulp)
        test_session.flush()

    test_session.add(ulp)
    test_session.flush()
    request.addfinalizer(fin)
    return ulp


@pytest.fixture(scope="function")
def user_language_preference_fr_explicit(request, test_session, fr_locale,
                                         admin_user):
    from assembl.models.auth import (
        UserLanguagePreference,
        LanguagePreferenceOrder
    )

    ulp = UserLanguagePreference(
        user=admin_user,
        locale=fr_locale,
        preferred_order=0,
        source_of_evidence=LanguagePreferenceOrder.Explicit)

    def fin():
        print "finalizer user_language_preference_cookie"
        test_session.delete(ulp)
        test_session.flush()

    test_session.add(ulp)
    test_session.flush()
    request.addfinalizer(fin)
    return ulp


@pytest.fixture(scope="function")
def user_language_preference_it_explicit(request, test_session, it_locale,
                                         admin_user):
    from assembl.models.auth import (
        UserLanguagePreference,
        LanguagePreferenceOrder
    )

    ulp = UserLanguagePreference(
        user=admin_user,
        locale=it_locale,
        preferred_order=0,
        source_of_evidence=LanguagePreferenceOrder.Explicit)

    def fin():
        print "finalizer user_language_preference_cookie"
        test_session.delete(ulp)
        test_session.flush()

    test_session.add(ulp)
    test_session.flush()
    request.addfinalizer(fin)
    return ulp


@pytest.fixture(scope="function")
def user_language_preference_de_explicit(request, test_session, de_locale,
                                         admin_user):
    from assembl.models.auth import (
        UserLanguagePreference,
        LanguagePreferenceOrder
    )

    ulp = UserLanguagePreference(
        user=admin_user,
        locale=de_locale,
        preferred_order=0,
        source_of_evidence=LanguagePreferenceOrder.Explicit)

    def fin():
        print "finalizer user_language_preference_cookie"
        test_session.delete(ulp)
        test_session.flush()

    test_session.add(ulp)
    test_session.flush()
    request.addfinalizer(fin)
    return ulp


@pytest.fixture(scope="function")
def user_language_preference_tr_explicit(request, test_session, tr_locale,
                                         admin_user):
    from assembl.models.auth import (
        UserLanguagePreference,
        LanguagePreferenceOrder
    )

    ulp = UserLanguagePreference(
        user=admin_user,
        locale=tr_locale,
        preferred_order=0,
        source_of_evidence=LanguagePreferenceOrder.Explicit)

    def fin():
        print "finalizer user_language_preference_cookie"
        test_session.delete(ulp)
        test_session.flush()

    test_session.add(ulp)
    test_session.flush()
    request.addfinalizer(fin)
    return ulp


@pytest.fixture(scope="function")
def user_language_preference_fr_mtfrom_en(request, test_session,
                                          en_locale, fr_locale,
                                          admin_user):
    from assembl.models.auth import (
        UserLanguagePreference,
        LanguagePreferenceOrder
    )

    ulp = UserLanguagePreference(
        user=admin_user,
        locale=en_locale,
        translate_to_locale=fr_locale,
        preferred_order=0,
        source_of_evidence=LanguagePreferenceOrder.Explicit)

    def fin():
        test_session.delete(ulp)
        test_session.flush()

    test_session.add(ulp)
    test_session.flush()
    request.addfinalizer(fin)
    return ulp


@pytest.fixture(scope="function")
def user_language_preference_en_mtfrom_fr(request, test_session,
                                          en_locale, fr_locale,
                                          admin_user):
    from assembl.models.auth import (
        UserLanguagePreference,
        LanguagePreferenceOrder
    )

    ulp = UserLanguagePreference(
        user=admin_user,
        locale=fr_locale,
        translate_to_locale=en_locale,
        preferred_order=0,
        source_of_evidence=LanguagePreferenceOrder.Explicit)

    def fin():
        test_session.delete(ulp)
        test_session.flush()

    test_session.add(ulp)
    test_session.flush()
    request.addfinalizer(fin)
    return ulp


@pytest.fixture(scope="function")
def user_language_preference_it_mtfrom_en(request, test_session,
                                          en_locale, it_locale,
                                          admin_user):
    from assembl.models.auth import (
        UserLanguagePreference,
        LanguagePreferenceOrder
    )

    ulp = UserLanguagePreference(
        user=admin_user,
        locale=en_locale,
        translate_to_locale=it_locale,
        preferred_order=0,
        source_of_evidence=LanguagePreferenceOrder.Explicit)

    def fin():
        test_session.delete(ulp)
        test_session.flush()

    test_session.add(ulp)
    test_session.flush()
    request.addfinalizer(fin)
    return ulp


@pytest.fixture(scope="function")
def user_language_preference_en_mtfrom_it(request, test_session,
                                          en_locale, it_locale,
                                          admin_user):
    from assembl.models.auth import (
        UserLanguagePreference,
        LanguagePreferenceOrder
    )

    ulp = UserLanguagePreference(
        user=admin_user,
        locale=it_locale,
        translate_to_locale=en_locale,
        preferred_order=0,
        source_of_evidence=LanguagePreferenceOrder.Explicit)

    def fin():
        test_session.delete(ulp)
        test_session.flush()

    test_session.add(ulp)
    test_session.flush()
    request.addfinalizer(fin)
    return ulp


@pytest.fixture(scope="function")
def user_language_preference_it_mtfrom_fr(request, test_session,
                                          fr_locale, it_locale,
                                          admin_user):
    from assembl.models.auth import (
        UserLanguagePreference,
        LanguagePreferenceOrder
    )

    ulp = UserLanguagePreference(
        user=admin_user,
        locale=fr_locale,
        translate_to_locale=it_locale,
        preferred_order=0,
        source_of_evidence=LanguagePreferenceOrder.Explicit)

    def fin():
        test_session.delete(ulp)
        test_session.flush()

    test_session.add(ulp)
    test_session.flush()
    request.addfinalizer(fin)
    return ulp


@pytest.fixture(scope="function")
def user_language_preference_fr_mtfrom_it(request, test_session,
                                          fr_locale, it_locale,
                                          admin_user):
    from assembl.models.auth import (
        UserLanguagePreference,
        LanguagePreferenceOrder
    )

    ulp = UserLanguagePreference(
        user=admin_user,
        locale=it_locale,
        translate_to_locale=fr_locale,
        preferred_order=0,
        source_of_evidence=LanguagePreferenceOrder.Explicit)

    def fin():
        test_session.delete(ulp)
        test_session.flush()

    test_session.add(ulp)
    test_session.flush()
    request.addfinalizer(fin)
    return ulp


@pytest.fixture(scope="function")
def user_language_preference_de_mtfrom_en(request, test_session,
                                          de_locale, en_locale,
                                          admin_user):
    from assembl.models.auth import (
        UserLanguagePreference,
        LanguagePreferenceOrder
    )

    ulp = UserLanguagePreference(
        user=admin_user,
        locale=en_locale,
        translate_to_locale=de_locale,
        preferred_order=0,
        source_of_evidence=LanguagePreferenceOrder.Explicit)

    def fin():
        test_session.delete(ulp)
        test_session.flush()

    test_session.add(ulp)
    test_session.flush()
    request.addfinalizer(fin)
    return ulp


@pytest.fixture(scope="function")
def user_language_preference_en_mtfrom_de(request, test_session,
                                          de_locale, en_locale,
                                          admin_user):
    from assembl.models.auth import (
        UserLanguagePreference,
        LanguagePreferenceOrder
    )

    ulp = UserLanguagePreference(
        user=admin_user,
        locale=de_locale,
        translate_to_locale=en_locale,
        preferred_order=0,
        source_of_evidence=LanguagePreferenceOrder.Explicit)

    def fin():
        test_session.delete(ulp)
        test_session.flush()

    test_session.add(ulp)
    test_session.flush()
    request.addfinalizer(fin)
    return ulp


@pytest.fixture(scope="function")
def langstring_entry_values():
    return {
        "subject": {
            "english":
                u"Here is an English subject that is very cool and hip.",
            "french":
                u"Voici un sujet anglais qui " +
                u"est très cool et branché.",
            "italian": u"Ecco un soggetto inglese che " +
                       u"è molto cool e alla moda.",
            "german": u"Hier ist ein englisches Thema, " +
                      u"das sehr cool und hip ist.",
            "turkish": u"Burada çok serin ve kalça bir İngiliz konudur.",
        },
        "body": {
            "english": u"Here is an English body that is " +
                       u"very cool and hip. And it is also longer.",
            "french": u"Voici un body anglais qui est très cool et branché. " +
                      u"Et il est également plus longue.",
            "italian": u"Qui è un organismo inglese che " +
                       u" è molto cool e alla moda. Ed è anche più.",
            "german": u"Hier ist ein englischer Körper, die sehr cool " +
                      u"und hip ist. Und es ist auch länger.",
            "turkish": u"Burada çok serin ve kalça bir İngiliz" +
                       u"organıdır. Ve aynı zamanda daha uzun."
        }
    }


@pytest.fixture(scope="function")
def en_langstring_entry(request, test_session, en_locale,
                        langstring_body, langstring_entry_values):
    from assembl.models.langstrings import LangStringEntry

    entry = LangStringEntry(
        locale_confirmed=False,
        langstring=langstring_body,
        locale=en_locale,
        value=langstring_entry_values.get('body').get('english')
    )

    test_session.expire(langstring_body, ["entries"])

    def fin():
        test_session.delete(entry)
        test_session.flush()

    test_session.add(entry)
    test_session.flush()
    request.addfinalizer(fin)
    return entry


@pytest.fixture(scope="function")
def fr_langstring_entry(request, test_session, fr_locale,
                        langstring_body, langstring_entry_values):
    from assembl.models.langstrings import LangStringEntry

    entry = LangStringEntry(
        locale_confirmed=False,
        langstring=langstring_body,
        locale=fr_locale,
        value=langstring_entry_values.get('body').get('french')
    )

    test_session.expire(langstring_body, ["entries"])

    def fin():
        test_session.delete(entry)
        test_session.flush()

    test_session.add(entry)
    test_session.flush()
    request.addfinalizer(fin)
    return entry


@pytest.fixture(scope="function")
def it_langstring_entry(request, test_session, it_locale,
                        langstring_body, langstring_entry_values):
    from assembl.models.langstrings import LangStringEntry

    entry = LangStringEntry(
        locale_confirmed=False,
        langstring=langstring_body,
        locale=it_locale,
        value=langstring_entry_values.get('body').get('italian')
    )

    test_session.expire(langstring_body, ["entries"])

    def fin():
        test_session.delete(entry)
        test_session.flush()

    test_session.add(entry)
    test_session.flush()
    request.addfinalizer(fin)
    return entry


@pytest.fixture(scope="function")
def tr_langstring_entry(request, test_session, tr_locale,
                        langstring_body, langstring_entry_values):
    from assembl.models.langstrings import LangStringEntry

    entry = LangStringEntry(
        locale_confirmed=False,
        langstring=langstring_body,
        locale=tr_locale,
        value=langstring_entry_values.get('body').get('turkish')
    )

    test_session.expire(langstring_body, ["entries"])

    def fin():
        test_session.delete(entry)
        test_session.flush()

    test_session.add(entry)
    test_session.flush()
    request.addfinalizer(fin)
    return entry


@pytest.fixture(scope="function")
def und_langstring_entry(request, test_session, undefined_locale,
                         langstring_body, langstring_entry_values):
    from assembl.models.langstrings import LangStringEntry

    entry = LangStringEntry(
        locale_confirmed=False,
        langstring=langstring_body,
        locale=undefined_locale,
        value=langstring_entry_values.get('body').get('english')
    )

    test_session.expire(langstring_body, ["entries"])

    def fin():
        test_session.delete(entry)
        test_session.flush()

    test_session.add(entry)
    test_session.flush()
    request.addfinalizer(fin)
    return entry


@pytest.fixture(scope="function")
def non_linguistic_langstring_entry(request, test_session,
                                    non_linguistic_locale, langstring_body,
                                    langstring_entry_values):
    from assembl.models.langstrings import LangStringEntry

    entry = LangStringEntry(
        locale_confirmed=False,
        langstring=langstring_body,
        locale=non_linguistic_locale,
        value=langstring_entry_values.get('body').get('english')
    )

    test_session.expire(langstring_body, ["entries"])

    def fin():
        test_session.delete(entry)
        test_session.flush()

    test_session.add(entry)
    test_session.flush()
    request.addfinalizer(fin)
    return entry


@pytest.fixture(scope="function")
def fr_from_en_langstring_entry(request, test_session, fr_from_en_locale,
                                langstring_body, en_langstring_entry,
                                langstring_entry_values):
    print "Creating fr_from_en_langstring_entry"
    from assembl.models.langstrings import LangStringEntry

    entry = LangStringEntry(
        locale_confirmed=False,
        langstring=langstring_body,
        locale=fr_from_en_locale,
        value=langstring_entry_values.get('body').get('french')
    )

    test_session.expire(langstring_body, ["entries"])

    def fin():
        print "Destroying fr_from_en_langstring_entry"
        test_session.delete(entry)
        test_session.flush()

    test_session.add(entry)
    test_session.flush()
    request.addfinalizer(fin)
    return entry


@pytest.fixture(scope="function")
def en_from_fr_langstring_entry(request, test_session, en_from_fr_locale,
                                langstring_body, fr_langstring_entry,
                                langstring_entry_values):

    from assembl.models.langstrings import LangStringEntry

    entry = LangStringEntry(
        locale_confirmed=False,
        langstring=langstring_body,
        locale=en_from_fr_locale,
        value=langstring_entry_values.get('body').get('english')
    )

    test_session.expire(langstring_body, ["entries"])

    def fin():
        test_session.delete(entry)
        test_session.flush()

    test_session.add(entry)
    test_session.flush()
    request.addfinalizer(fin)
    return entry


@pytest.fixture(scope="function")
def it_from_en_langstring_entry(request, test_session, it_from_en_locale,
                                langstring_body, en_langstring_entry,
                                langstring_entry_values):
    print "Creating fr_from_en_langstring_entry"
    from assembl.models.langstrings import LangStringEntry

    entry = LangStringEntry(
        locale_confirmed=False,
        langstring=langstring_body,
        locale=it_from_en_locale,
        value=langstring_entry_values.get('body').get('italian')
    )

    test_session.expire(langstring_body, ["entries"])

    def fin():
        test_session.delete(entry)
        test_session.flush()

    test_session.add(entry)
    test_session.flush()
    request.addfinalizer(fin)
    return entry


@pytest.fixture(scope="function")
def en_from_it_langstring_entry(request, test_session, en_from_it_locale,
                                langstring_body, it_langstring_entry,
                                langstring_entry_values):

    from assembl.models.langstrings import LangStringEntry

    entry = LangStringEntry(
        locale_confirmed=False,
        langstring=langstring_body,
        locale=en_from_it_locale,
        value=langstring_entry_values.get('body').get('english')
    )

    test_session.expire(langstring_body, ["entries"])

    def fin():
        test_session.delete(entry)
        test_session.flush()

    test_session.add(entry)
    test_session.flush()
    request.addfinalizer(fin)
    return entry


@pytest.fixture(scope="function")
def it_from_fr_langstring_entry(request, test_session, it_from_fr_locale,
                                langstring_body, fr_langstring_entry,
                                langstring_entry_values):
    print "Creating fr_from_en_langstring_entry"
    from assembl.models.langstrings import LangStringEntry

    entry = LangStringEntry(
        locale_confirmed=False,
        langstring=langstring_body,
        locale=it_from_fr_locale,
        value=langstring_entry_values.get('body').get('italian')
    )

    test_session.expire(langstring_body, ["entries"])

    def fin():
        test_session.delete(entry)
        test_session.flush()

    test_session.add(entry)
    test_session.flush()
    request.addfinalizer(fin)
    return entry


@pytest.fixture(scope="function")
def fr_from_it_langstring_entry(request, test_session, fr_from_it_locale,
                                langstring_body, it_langstring_entry,
                                langstring_entry_values):

    from assembl.models.langstrings import LangStringEntry

    entry = LangStringEntry(
        locale_confirmed=False,
        langstring=langstring_body,
        locale=fr_from_it_locale,
        value=langstring_entry_values.get('body').get('french')
    )

    test_session.expire(langstring_body, ["entries"])

    def fin():
        test_session.delete(entry)
        test_session.flush()

    test_session.add(entry)
    test_session.flush()
    request.addfinalizer(fin)
    return entry


@pytest.fixture(scope="function")
def en_from_tr_langstring_entry(request, test_session, en_from_tr_locale,
                                langstring_body, tr_langstring_entry,
                                langstring_entry_values):

    from assembl.models.langstrings import LangStringEntry

    entry = LangStringEntry(
        locale_confirmed=False,
        langstring=langstring_body,
        locale=en_from_tr_locale,
        value=langstring_entry_values.get('body').get('english')
    )

    test_session.expire(langstring_body, ["entries"])

    def fin():
        test_session.delete(entry)
        test_session.flush()

    test_session.add(entry)
    test_session.flush()
    request.addfinalizer(fin)
    return entry


@pytest.fixture(scope="function")
def de_from_tr_langstring_entry(request, test_session, de_from_tr_locale,
                                langstring_body, tr_langstring_entry,
                                langstring_entry_values):

    from assembl.models.langstrings import LangStringEntry

    entry = LangStringEntry(
        locale_confirmed=False,
        langstring=langstring_body,
        locale=de_from_tr_locale,
        value=langstring_entry_values.get('body').get('german')
    )

    test_session.expire(langstring_body, ["entries"])

    def fin():
        test_session.delete(entry)
        test_session.flush()

    test_session.add(entry)
    test_session.flush()
    request.addfinalizer(fin)
    return entry


@pytest.fixture(scope="function")
def fr_from_und_langstring_entry(request, test_session, fr_from_und_locale,
                                 langstring_body, und_langstring_entry,
                                 langstring_entry_values):

    from assembl.models.langstrings import LangStringEntry

    entry = LangStringEntry(
        locale_confirmed=False,
        langstring=langstring_body,
        locale=fr_from_und_locale,
        value=langstring_entry_values.get('body').get('french')
    )

    test_session.expire(langstring_body, ["entries"])

    def fin():
        test_session.delete(entry)
        test_session.flush()

    test_session.add(entry)
    test_session.flush()
    request.addfinalizer(fin)
    return entry


@pytest.fixture(scope="function")
def langstring_body(request, test_session):
    from assembl.models.langstrings import LangString

    ls = LangString()
    test_session.add(ls)
    test_session.flush()

    def fin():
        test_session.delete(ls)
        test_session.flush()

    request.addfinalizer(fin)
    return ls


@pytest.fixture(scope="function")
def langstring_subject(request, test_session):
    from assembl.models.langstrings import LangString

    ls = LangString()
    test_session.add(ls)
    test_session.flush()

    def fin():
        test_session.delete(ls)
        test_session.flush()

    request.addfinalizer(fin)
    return ls
