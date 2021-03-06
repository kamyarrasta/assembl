from collections import defaultdict
from datetime import datetime
from abc import abstractmethod
from itertools import chain

from sqlalchemy.orm import (
    relationship, backref)
from sqlalchemy import (
    Column,
    Integer,
    String,
    UnicodeText,
    DateTime,
    ForeignKey,
)
from sqlalchemy.ext.associationproxy import association_proxy
from sqlalchemy.orm import join
import lxml.html as htmlt

from . import DiscussionBoundBase
from .discussion import Discussion
from ..semantic.virtuoso_mapping import QuadMapPatternS
from ..auth import (
    CrudPermissions, P_ADMIN_DISC, P_EDIT_SYNTHESIS)
from .idea import Idea, IdeaLink, RootIdea, IdeaVisitor
from ..semantic.namespaces import (
    SIOC, CATALYST, IDEA, ASSEMBL, DCTERMS, QUADNAMES)
from assembl.views.traversal import AbstractCollectionDefinition


class defaultdictlist(defaultdict):
    def __init__(self):
        super(defaultdictlist, self).__init__(list)


class IdeaGraphView(DiscussionBoundBase):
    """
    A view on the graph of idea.
    """
    __tablename__ = "idea_graph_view"
    rdf_class = CATALYST.Map

    type = Column(String(60), nullable=False)
    id = Column(Integer, primary_key=True,
                info={'rdf': QuadMapPatternS(None, ASSEMBL.db_id)})

    creation_date = Column(DateTime, nullable=False, default=datetime.utcnow,
        info={'rdf': QuadMapPatternS(None, DCTERMS.created)})

    discussion_id = Column(
        Integer,
        ForeignKey('discussion.id', ondelete="CASCADE", onupdate="CASCADE"),
        nullable=False,
        info={'rdf': QuadMapPatternS(None, SIOC.has_container)}
    )
    discussion = relationship(
        Discussion, backref=backref("views", cascade="all, delete-orphan"),
        info={'rdf': QuadMapPatternS(None, ASSEMBL.in_conversation)})

    __mapper_args__ = {
        'polymorphic_identity': 'idea_graph_view',
        'polymorphic_on': 'type',
        'with_polymorphic': '*'
    }

    def copy(self):
        retval = self.__class__()
        retval.discussion = self.discussion
        return retval

    def get_discussion_id(self):
        return self.discussion_id

    @classmethod
    def get_discussion_conditions(cls, discussion_id, alias_maker=None):
        return (cls.discussion_id == discussion_id, )

    crud_permissions = CrudPermissions(P_ADMIN_DISC)

    @abstractmethod
    def get_idea_links(self):
        pass

    @abstractmethod
    def get_ideas(self):
        pass



class SubGraphIdeaAssociation(DiscussionBoundBase):
    __tablename__ = 'sub_graph_idea_association'
    id = Column(Integer, primary_key=True)
    sub_graph_id = Column(Integer, ForeignKey(
        'explicit_sub_graph_view.id', ondelete="CASCADE", onupdate="CASCADE"),
        index=True, nullable=False)
    sub_graph = relationship(
        "ExplicitSubGraphView", backref=backref(
            "idea_assocs", cascade="all, delete-orphan"))
    idea_id = Column(Integer, ForeignKey(
        'idea.id', ondelete="CASCADE", onupdate="CASCADE"),
        nullable=False, index=True)
    # reference to the "Idea" object for proxying
    idea = relationship("Idea")

    @classmethod
    def special_quad_patterns(cls, alias_maker, discussion_id):
        idea_assoc = alias_maker.alias_from_class(cls)
        idea_alias = alias_maker.alias_from_relns(cls.idea)
        # Assume tombstone status of target is similar to source, for now.
        conditions = [(idea_assoc.idea_id == idea_alias.id),
                      (idea_alias.tombstone_date == None)]
        if discussion_id:
            conditions.append((idea_alias.discussion_id == discussion_id))
        return [
            QuadMapPatternS(
                Idea.iri_class().apply(idea_assoc.idea_id),
                IDEA.inMap,
                IdeaGraphView.iri_class().apply(idea_assoc.sub_graph_id),
                conditions=conditions,
                name=QUADNAMES.sub_graph_idea_assoc_reln)
        ]

    def get_discussion_id(self):
        sub_graph = self.sub_graph or IdeaGraphView.get(self.sub_graph_id)
        return sub_graph.get_discussion_id()

    @classmethod
    def get_discussion_conditions(cls, discussion_id, alias_maker=None):
        return ((cls.sub_graph_id == ExplicitSubGraphView.id),
                (ExplicitSubGraphView.discussion_id == discussion_id))

    discussion = relationship(
        Discussion, viewonly=True, uselist=False, secondary=Idea.__table__,
        info={'rdf': QuadMapPatternS(None, ASSEMBL.in_conversation)})

    def unique_query(self):
        # documented in lib/sqla
        idea_id = self.idea_id or self.idea.id
        subgraph_id = self.sub_graph_id or self.sub_graph.id
        return self.db.query(self.__class__).filter_by(
            idea_id=idea_id, sub_graph_id=subgraph_id), True

    # @classmethod
    # def special_quad_patterns(cls, alias_maker, discussion_id):
    #     return [QuadMapPatternS(
    #         Idea.iri_class().apply(cls.source_id),
    #         IDEA.includes,
    #         Idea.iri_class().apply(cls.target_id),
    #         name=QUADNAMES.idea_inclusion_reln)]

    crud_permissions = CrudPermissions(P_ADMIN_DISC)


class SubGraphIdeaLinkAssociation(DiscussionBoundBase):
    __tablename__ = 'sub_graph_idea_link_association'
    id = Column(Integer, primary_key=True)

    sub_graph_id = Column(Integer, ForeignKey(
        'explicit_sub_graph_view.id', ondelete="CASCADE", onupdate="CASCADE"),
        index=True, nullable=False)
    sub_graph = relationship(
        "ExplicitSubGraphView", backref=backref(
            "idealink_assocs", cascade="all, delete-orphan"))

    idea_link_id = Column(Integer, ForeignKey(
        'idea_idea_link.id', ondelete="CASCADE", onupdate="CASCADE"),
        index=True, nullable=False)

    # reference to the "IdeaLink" object for proxying
    idea_link = relationship("IdeaLink")

    @classmethod
    def special_quad_patterns(cls, alias_maker, discussion_id):
        idea_link_assoc = alias_maker.alias_from_class(cls)
        idea_link_alias = alias_maker.alias_from_relns(cls.idea_link)
        # Assume tombstone status of target is similar to source, for now.
        conditions = [(idea_link_assoc.idea_link_id == idea_link_alias.id),
                      (idea_link_alias.tombstone_date == None)]
        if discussion_id:
            conditions.extend(cls.get_discussion_conditions(
                discussion_id, alias_maker))

        return [
            QuadMapPatternS(
                IdeaLink.iri_class().apply(idea_link_assoc.idea_link_id),
                IDEA.inMap,
                IdeaGraphView.iri_class().apply(idea_link_assoc.sub_graph_id),
                conditions=conditions,
                name=QUADNAMES.sub_graph_idea_link_assoc_reln)
        ]

    def get_discussion_id(self):
        sub_graph = self.sub_graph or IdeaGraphView.get(self.sub_graph_id)
        return sub_graph.get_discussion_id()

    def unique_query(self):
        # documented in lib/sqla
        idea_link_id = self.idea_link_id or self.idea_link.id
        subgraph_id = self.sub_graph_id or self.sub_graph.id
        return self.db.query(self.__class__).filter_by(
            idea_link_id=idea_link_id, sub_graph_id=subgraph_id), True

    @classmethod
    def get_discussion_conditions(cls, discussion_id, alias_maker=None):
        if alias_maker:
            subgraph_alias = alias_maker.alias_from_relns(cls.sub_graph)
            return ((subgraph_alias.discussion_id == discussion_id))
        else:
            return ((cls.sub_graph_id == ExplicitSubGraphView.id),
                    (ExplicitSubGraphView.discussion_id == discussion_id))

    crud_permissions = CrudPermissions(P_ADMIN_DISC)


class ExplicitSubGraphView(IdeaGraphView):
    """
    A view where the Ideas and/or ideaLinks have been explicitly selected.

    Note that ideaLinks may point to ideas that are not in the graph.  They
    should be followed transitively (if their nature is compatible) to reach
    every idea in graph as if they were directly linked.
    """
    __tablename__ = "explicit_sub_graph_view"

    id = Column(Integer, ForeignKey(
        'idea_graph_view.id',
        ondelete='CASCADE',
        onupdate='CASCADE'
    ), primary_key=True)

    # proxy the 'idea' attribute from the 'idea_assocs' relationship
    # for direct access
    ideas = association_proxy('idea_assocs', 'idea',
        creator=lambda idea: SubGraphIdeaAssociation(idea=idea))

    # proxy the 'idea_link' attribute from the 'idealink_assocs'
    # relationship for direct access
    idea_links = association_proxy('idealink_assocs', 'idea_link',
        creator=lambda idea_link: SubGraphIdeaLinkAssociation(idea_link=idea_link))

    __mapper_args__ = {
        'polymorphic_identity': 'explicit_sub_graph_view',
    }

    def copy(self):
        retval = IdeaGraphView.copy(self)
        # retval.ideas = self.ideas
        return retval

    def get_idea_links(self):
        # more efficient than the association_proxy
        return self.db.query(IdeaLink).join(
            SubGraphIdeaLinkAssociation
            ).filter_by(sub_graph_id=self.id).all()

    def get_ideas(self):
        # more efficient than the association_proxy
        return self.db.query(Idea).join(
            SubGraphIdeaAssociation
            ).filter_by(sub_graph_id=self.id).all()

    def visit_ideas_depth_first(self, idea_visitor):
        # prefetch
        ideas_by_id = {idea.id: idea for idea in self.get_ideas()}
        children_links = defaultdict(list)
        for link in self.get_idea_links():
            children_links[link.source_id].append(link)
        for links in children_links.itervalues():
            links.sort(key=lambda l: l.order)
        root = self.discussion.root_idea
        root = ideas_by_id.get(root.base_id, root)
        return self._visit_ideas_depth_first(
            root.id, ideas_by_id, children_links, idea_visitor, set(), 0, None)

    def _visit_ideas_depth_first(
            self, idea_id, ideas_by_id, children_links, idea_visitor,
            visited, level, prev_result):
        result = None
        if idea_id in visited:
            # not necessary in a tree, but let's start to think graph.
            return False
        idea = ideas_by_id.get(idea_id, None)
        if idea:
            result = idea_visitor.visit_idea(idea, level, prev_result)
        visited.add(idea_id)
        child_results = []
        if result is not IdeaVisitor.CUT_VISIT:
            for link in children_links[idea_id]:
                child_id = link.target_id
                r = self._visit_ideas_depth_first(
                    child_id, ideas_by_id, children_links, idea_visitor,
                    visited, level+1, result)
                if r:
                    child_results.append(r)
        return idea_visitor.end_visit(idea, level, result, child_results)

    @classmethod
    def extra_collections(cls):
        class GViewIdeaCollectionDefinition(AbstractCollectionDefinition):
            def __init__(self, cls):
                super(GViewIdeaCollectionDefinition, self).__init__(cls, Idea)

            def decorate_query(self, query, owner_alias, last_alias,
                               parent_instance, ctx):
                return query.join(SubGraphIdeaAssociation, owner_alias)

            def decorate_instance(
                    self, instance, parent_instance, assocs, user_id,
                    ctx, kwargs):
                for inst in assocs[:]:
                    if isinstance(inst, Idea):
                        assocs.append(SubGraphIdeaAssociation(
                            idea=inst, sub_graph=parent_instance,
                            **self.filter_kwargs(
                                SubGraphIdeaAssociation, kwargs)))
                    elif isinstance(inst, IdeaLink):
                        assocs.append(SubGraphIdeaLinkAssociation(
                                idea_link=inst, sub_graph=parent_instance,
                                **self.filter_kwargs(
                                    SubGraphIdeaLinkAssociation, kwargs)))

            def contains(self, parent_instance, instance):
                return instance.db.query(
                    SubGraphIdeaAssociation).filter_by(
                        idea=instance,
                        sub_graph=parent_instance
                    ).count() > 0

        class GViewIdeaLinkCollectionDefinition(AbstractCollectionDefinition):
            def __init__(self, cls):
                super(GViewIdeaLinkCollectionDefinition, self
                      ).__init__(cls, IdeaLink)

            def decorate_query(self, query, owner_alias, last_alias,
                               parent_instance, ctx):
                return query.join(SubGraphIdeaLinkAssociation, owner_alias)

            def decorate_instance(
                    self, instance, parent_instance, assocs, user_id,
                    ctx, kwargs):
                if isinstance(instance, IdeaLink):
                    assocs.append(
                        SubGraphIdeaLinkAssociation(
                            idea_link=instance, sub_graph=parent_instance,
                            **self.filter_kwargs(
                                SubGraphIdeaLinkAssociation, kwargs)))

            def contains(self, parent_instance, instance):
                return instance.db.query(
                    SubGraphIdeaLinkAssociation).filter_by(
                        idea_link=instance,
                        sub_graph=parent_instance
                    ).count() > 0

        return {'ideas': GViewIdeaCollectionDefinition(cls),
                'idea_links': GViewIdeaLinkCollectionDefinition(cls)}

    crud_permissions = CrudPermissions(P_ADMIN_DISC)


SubGraphIdeaLinkAssociation.discussion = relationship(
        Discussion, viewonly=True, uselist=False,
        secondary=join(
            ExplicitSubGraphView, IdeaGraphView,
            ExplicitSubGraphView.id == IdeaGraphView.id),
        info={'rdf': QuadMapPatternS(None, ASSEMBL.in_conversation)})


class TableOfContents(IdeaGraphView):
    """
    Represents a Table of Ideas.

    A ToI in Assembl is used to organize the core ideas of a discussion in a
    threaded hierarchy.
    """
    __tablename__ = "table_of_contents"

    id = Column(Integer, ForeignKey(
        'idea_graph_view.id',
        ondelete='CASCADE',
        onupdate='CASCADE'
    ), primary_key=True)

    __mapper_args__ = {
        'polymorphic_identity': 'table_of_contents',
    }

    discussion = relationship(
        Discussion, backref=backref("table_of_contents", uselist=False))

    def get_discussion_id(self):
        return self.discussion.id

    @classmethod
    def get_discussion_conditions(cls, discussion_id, alias_maker=None):
        return (cls.discussion_id == discussion_id,)

    def get_idea_links(self):
        return self.discussion.get_idea_links()

    def get_ideas(self):
        return self.discussion.ideas

    def __repr__(self):
        r = super(TableOfContents, self).__repr__()
        return r[:-1] + self.discussion.slug + ">"


class Synthesis(ExplicitSubGraphView):
    """
    A synthesis of the discussion.  A selection of ideas, associated with
    comments, sent periodically to the discussion.

    A synthesis only has link's to ideas before publication (as it is edited)
    Once published, if freezes the links by copying tombstoned versions of
    each link in the discussion.
    """
    __tablename__ = "synthesis"

    id = Column(Integer, ForeignKey(
        'explicit_sub_graph_view.id',
        ondelete='CASCADE',
        onupdate='CASCADE'
    ), primary_key=True)

    subject = Column(UnicodeText)
    introduction = Column(UnicodeText)
    conclusion = Column(UnicodeText)

    __mapper_args__ = {
        'polymorphic_identity': 'synthesis',
    }

    def copy(self):
        retval = ExplicitSubGraphView.copy(self)
        retval.subject = self.subject
        retval.introduction = self.introduction
        retval.conclusion = self.conclusion
        return retval

    def publish(self):
        """ Publication is the end of a synthesis's lifecycle.
        It creates and returns a frozen copy of its state 
        using tombstones for ideas and links."""
        frozen_synthesis = self.copy()
        self.db.add(frozen_synthesis)
        self.db.flush()

        # Copy tombstoned versions of all idea links and relevant ideas in the current synthesis
        links = Idea.get_all_idea_links(self.discussion_id)
        synthesis_idea_ids = {idea.id for idea in self.ideas}
        # Do not copy the root
        root = self.discussion.root_idea
        idea_copies = {root.id: root}
        # Also copies ideas between two synthesis ideas
        relevant_idea_ids = synthesis_idea_ids.copy()
        def add_ancestors_between(idea, path=None):
            if isinstance(idea, RootIdea):
                return
            path = path[:] if path else []
            if idea.id in synthesis_idea_ids:
                relevant_idea_ids.update({i.id for i in path})
            else:
                path.append(idea)
            for parent in idea.parents:
                add_ancestors_between(parent, path)
        for idea in self.ideas:
            for parent in idea.parents:
                add_ancestors_between(parent)
        for link in links:
            new_link = link.copy(tombstone=True)
            frozen_synthesis.idea_links.append(new_link)
            if link.source_id in relevant_idea_ids:
                if link.source_id not in idea_copies:
                    new_idea = link.source_ts.copy(tombstone=True)
                    idea_copies[link.source_id] = new_idea
                    if link.source_id in synthesis_idea_ids:
                        frozen_synthesis.ideas.append(new_idea)
                new_link.source_ts = idea_copies[link.source_id]
            if link.target_id in relevant_idea_ids:
                if link.target_id not in idea_copies:
                    new_idea = link.target_ts.copy(tombstone=True)
                    idea_copies[link.target_id] = new_idea
                    if link.target_id in synthesis_idea_ids:
                        frozen_synthesis.ideas.append(new_idea)
                new_link.target_ts = idea_copies[link.target_id]
        return frozen_synthesis

    def as_html(self, jinja_env):
        v = SynthesisHtmlizationVisitor(self, jinja_env)
        self.visit_ideas_depth_first(v)
        return v.as_html()

    @property
    def is_next_synthesis(self):
        return self.discussion.get_next_synthesis() == self

    def get_discussion_id(self):
        return self.discussion_id

    @classmethod
    def get_discussion_conditions(cls, discussion_id, alias_maker=None):
        return (cls.discussion_id == discussion_id,)

    def __repr__(self):
        r = super(Synthesis, self).__repr__()
        subject = self.subject or ""
        return r[:-1] + subject.encode("ascii", "ignore") + ">"

    crud_permissions = CrudPermissions(P_EDIT_SYNTHESIS)


class SynthesisHtmlizationVisitor(IdeaVisitor):
    def __init__(self, graph_view, jinja_env):
        self.jinja_env = jinja_env
        self.idea_template = jinja_env.get_template('idea_in_synthesis.jinja2')
        self.synthesis_template = jinja_env.get_template('synthesis.jinja2')
        self.graph_view = graph_view

    def visit_idea(self, idea, level, prev_result):
        return True

    def end_visit(self, idea, level, prev_result, child_results):
        if prev_result is not True:
            idea = None
        if idea or child_results:
            self.result = self.idea_template.render(
                idea=idea, children=child_results, level=level)
            return self.result

    def as_html(self):
        return self.synthesis_template.render(
            synthesis=self.graph_view, content=self.result)
