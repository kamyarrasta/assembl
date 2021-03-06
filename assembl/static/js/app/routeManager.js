'use strict';

var Marionette = require('./shims/marionette.js'),
    Assembl = require('./app.js'),
    Promise = require('bluebird'),
    Ctx = require('./common/context.js'),
    Agents = require('./models/agents.js'),
    Storage = require('./objects/storage.js'),
    Loader = require('./views/loader.js'),
    NavBar = require('./views/navBar.js'),
    Infobars = require('./views/infobar.js'),
    UrlParser = require('./url/url.js'),
    GroupContainer = require('./views/groups/groupContainer.js'),
    PanelSpecTypes = require('./utils/panelSpecTypes.js'),
    CollectionManager = require('./common/collectionManager.js'),
    ViewsFactory = require('./objects/viewsFactory.js'),
    AdminDiscussion = require('./views/admin/adminDiscussion.js'),
    AdminNotificationSubscriptions = require('./views/admin/adminNotificationSubscriptions.js'),
    AdminPartners = require('./views/admin/adminPartners.js'),
    UserNotificationSubscriptions = require('./views/user/userNotificationSubscriptions.js'),
    Profile = require('./views/user/profile.js'),
    AgentViews = require('./views/agent.js'),
    Authorization = require('./views/authorization.js'),
    Permissions = require('./utils/permissions.js'),
    Account = require('./views/user/account.js'),
    Widget = require('./models/widget.js'),
    AdminDiscussionSettings = require('./views/admin/adminDiscussionSettings.js'),
    PreferencesView = require('./views/preferencesView.js'),
    FirstIdeaToShowVisitor = require('./views/visitors/firstIdeaToShowVisitor.js'),
    i18n = require('./utils/i18n.js'),
    Analytics = require('./internal_modules/analytics/dispatcher.js');

var QUERY_STRINGS = {
  'source': ['notification', 'share']
};

var trackAnalyticsWithQueryString = function(qs, context){
  
  //console.log('tracking with query string ' + qs + ' using context ' + context);

  function arrayHas(array, id){
    var result = false;
    _.each(array, function(a){
      if (a === id){
        result = true;
      }
    });
    return result;
  };

  function doCheck(param, success){
    var tmp = param.split('='),
        k = tmp[0],
        v = tmp[1];

    if ( _.has(QUERY_STRINGS, k) ){
      if ( arrayHas(QUERY_STRINGS[k], v) ){
        success(k,v);
      }
      else {
        console.warn('[Analytics] Query string ' + k + '=' + v + ' ; ' + k + ' is valid, but ' + v + ' does nothing.');
      }
    }
    else {
      console.warn('[Analytics] Query string ' + k + '=' + v + ' does nothing');
    }
  };

  var analytics = Analytics.getInstance();

  var cb = function(key, value){
    //Define what type of event is fired here
    switch(value){
      case 'notification':
        if (context === 'post'){
          //console.log('trackEvent enter post via notification');
          analytics.trackEvent(analytics.events.ENTER_POST_VIA_NOTIFICATION);
        }
        else {
          console.warn("Unknown context "+context);
        }
        
        break;
      case 'share':
        if (context === 'post'){
          //console.log('trackEvent enter post via share');
          analytics.trackEvent(analytics.events.ENTER_POST_VIA_SHARE);
        }
        else if (context === 'idea') {
          //console.log('trackEvent enter idea via share');
          analytics.trackEvent(analytics.events.ENTER_IDEA_VIA_SHARE);
        }
        else {
          console.warn("Unknown context "+context);
        }
        break;
      default:
        //Question, should there be an "UNKNOWN" case for ideas and messages here
        //so we find new cases we forgot.  For example we'll soon add the synthesis
        //to notifications, which will point to ideas.  It wouldn't be logged at 
        //all as it is, even IF is add the 'idea' context to the share url.
        console.warn("Unknown value "+value);
        break;
    }

  };
  if (qs) {
    if ( qs.indexOf('&') > -1 ){
      _.each( qs.split('&'), function(param){
        doCheck(param, cb);
      });
    }
    else {
      doCheck(qs, cb);
    }
  }
  else {
    console.warn("Ùnable to track event, there are no event tracking query parameters present.")
  }

};

var routeManager = Marionette.Object.extend({

  initialize: function() {
    window.assembl = {};

    this.collectionManager = new CollectionManager();

    /**
     * fulfill app.currentUser
     */
    this.loadCurrentUser();
  },

  defaults: function() {
    Backbone.history.navigate('', true);
  },

  home: function() {
    this.restoreViews(true);
  },

  edition: function() {
    Assembl.headerRegions.show(new NavBar());
    if (this.userHaveAccess()) {
      var edition = new AdminDiscussion();
      Assembl.groupContainer.show(edition);
    }
  },

  partners: function() {
    Assembl.headerRegions.show(new NavBar());
    if (this.userHaveAccess()) {
      var partners = new AdminPartners();
      Assembl.groupContainer.show(partners);
    }
  },

  notifications: function() {
    Assembl.headerRegions.show(new NavBar());
    if (this.userHaveAccess()) {
      var notifications = new AdminNotificationSubscriptions();
      Assembl.groupContainer.show(notifications);
    }
  },

  settings: function() {
    Assembl.headerRegions.show(new NavBar());
    if (this.userHaveAccess()) {
      var adminSetting = new AdminDiscussionSettings();
      Assembl.groupContainer.show(adminSetting);
    }
  },

  adminDiscussionPreferences: function() {
    Assembl.headerRegions.show(new NavBar());
    if (this.userHaveAccess()) {
      var page = new PreferencesView.DiscussionPreferencesView();
      Assembl.groupContainer.show(page);
    }
  },

  userNotifications: function() {
    Assembl.headerRegions.show(new NavBar());
    if (this.userHaveAccess()) {
      var user = new UserNotificationSubscriptions();
      Assembl.groupContainer.show(user);
    }
  },

  profile: function() {
    Assembl.headerRegions.show(new NavBar());
    if (this.userHaveAccess()) {
      var profile = new Profile();
      Assembl.groupContainer.show(profile);
    }
  },

  userDiscussionPreferences: function() {
    Assembl.headerRegions.show(new NavBar());
    if (this.userHaveAccess()) {
      var page = new PreferencesView.UserPreferencesView();
      Assembl.groupContainer.show(page);
    }
  },

  account: function() {
    Assembl.headerRegions.show(new NavBar());
    if (this.userHaveAccess()) {
      var account = new Account();
      Assembl.groupContainer.show(account);
    }
  },

  post: function(id, qs) {
      //TODO: add new behavior to show messageList Panel
      // We are skiping restoring the group state

      trackAnalyticsWithQueryString(qs, 'post');

      this.restoreViews(undefined, undefined, true).then(function(groups) {
        var firstGroup = groups.children.first();
        var messageList = firstGroup.findViewByType(PanelSpecTypes.MESSAGE_LIST);
        if (!messageList) {
          if (firstGroup.isSimpleInterface()) {
            Assembl.vent.trigger("DEPRECATEDnavigation:selected", 'debate', null);
          }
          else {
            throw new Error("WRITEME:  There was no group with a messagelist available");
          }
        }
        if(!messageList.isViewStyleThreadedType(messageList.currentViewStyle)) {
          //We need context for the message
          //Set the view style to default (supposed to be a threaded type)
          //but do not store it
          messageList.setViewStyle(null, true); 
        }

        Assembl.vent.trigger('messageList:showMessageById', id);

        Backbone.history.navigate('/', {replace: true});
      });
    },

  idea: function(id, qs) {
    //TODO: add new behavior to show messageList Panel
    
    trackAnalyticsWithQueryString(qs, 'idea');
    this.restoreViews().then(function() {
      //We really need to address panels explicitely
      Assembl.vent.trigger("DEPRECATEDnavigation:selected", 'debate', null);
      Assembl.vent.trigger('DEPRECATEDideaList:selectIdea', id, "from_url", true);
    });

    //TODO: fix this horrible hack that prevents calling
    //showMessageById over and over.
    //window.history.pushState('object or string', 'Title', '../');
    Backbone.history.navigate('/', {replace: true});
  },

  user: function(id, qs) {
    this.restoreViews().then(function() {    
      var collectionManager = CollectionManager(); 
      collectionManager.getAllUsersCollectionPromise().then(
          function(agentsCollection) {
            var agent = agentsCollection.get(id);
            if(!agent) {
              console.log(agentsCollection, id)
              throw new error("User not found");
            }
            AgentViews.showUserMessages(agent);
          });
    });
    Backbone.history.navigate('/', {replace: true});
  },

  // example: http://localhost:6543/jacklayton/widget/local%3AWidget%2F64
  widgetInModal: function(id) {
    this.restoreViews().then(function(groups) {
      var collectionManager = CollectionManager();
      var widgetPromise = collectionManager.getAllWidgetsPromise()
        .then(function(allWidgetsCollection) {
          return Promise.resolve(allWidgetsCollection.get(id))
            .catch(function(e) {
              console.error(e.statusText);
            });
        });
      widgetPromise.then(function(widget){
        var options = {
          "target_url": widget.getUrlForUser(),
          "modal_title": widget.getLinkText(Widget.Model.prototype.INFO_BAR)
        };
        Ctx.openTargetInModal(null, null, options);
      });
      Backbone.history.navigate('/', {replace: true});
    });
  },

  about: function() {
      this.restoreViews(undefined, undefined, true).then(function(groups) {
        var firstGroup = groups.children.first();
        if (firstGroup.isSimpleInterface()) {
          Assembl.vent.trigger("DEPRECATEDnavigation:selected", 'about');
        } else {
            // should we then switch to simple interface?
        }
        Backbone.history.navigate('/', {replace: true});
      });
    },

  sentryTest: function() {
    var Raven = require('raven-js');
    Raven.captureMessage("This is a test, an uncaught non existent function call will follow.");
    //This crashes on purpose
    crashme();
  },

  loadCurrentUser: function() {
    var user = null;
    if (Ctx.getCurrentUserId()) {
      user = new Agents.Model();
      user.fetchFromScriptTag('current-user-json');
    }
    else {
      user = new Agents.Collection().getUnknownUser();
    }

    user.fetchPermissionsFromScriptTag();
    Ctx.setCurrentUser(user);
    Ctx.loadCsrfToken(true);
  },

  groupSpec: function(path) {
    console.log(path);
    try {
      var structure = UrlParser.parse("/" + path);
      console.log(structure);
      this.restoreViews(false, structure);
    } catch (e) {
      Raven.captureException(e);
      this.restoreViews(true);
    }
  },

  /**
   * @param from_home:  If true, the function was called from the home view
   * @return promise to a GroupContainer
   */
  restoreViews: function(from_home, url_structure, skip_group_state) {
    var collectionManager = CollectionManager();
    Assembl.headerRegions.show(new NavBar());
    collectionManager.getWidgetsForContextPromise(
      Widget.Model.prototype.INFO_BAR, null, ["closeInfobar"]).then(
      function(coll) {
        Assembl.infobarRegion.show(new Infobars({collection: coll}));
      });
    Assembl.groupContainer.show(new Loader());
    /**
     * Render the current group of views
     * */
    var groupSpecsP = this.collectionManager.getGroupSpecsCollectionPromise(ViewsFactory, url_structure, skip_group_state);

    return groupSpecsP.then(function(groupSpecs) {
      var groupsView = new GroupContainer({
        collection: groupSpecs
      });

      var lastSave = Storage.getDateOfLastViewSave(),
          currentUser = Ctx.getCurrentUser();
      if (lastSave && !lastSave.getDate()) {
        // case of Invalid Date
        lastSave = null;
      }

      groupsView.render(); //So children can be used

      if (from_home && !lastSave && (
              currentUser.isUnknownUser() || currentUser.get('is_first_visit'))) {
        Promise.join(collectionManager.getAllIdeasCollectionPromise(),
                     collectionManager.getAllExtractsCollectionPromise(),
                     collectionManager.getAllIdeaLinksCollectionPromise(),
                             function(ideas, extracts, links) {
                               var visitor = new FirstIdeaToShowVisitor(extracts);
                               ideas.visitBreadthFirst(links, visitor, ideas.getRootIdea().getId());
                               var idea = visitor.ideaWithExtract || visitor.firstIdea;
                               if (idea !== undefined) {
                                 // the table of ideas view did not start listening yet.
                                 // TODO: Break magic timeout.
                                 setTimeout(function() {
                                   Assembl.vent.trigger('DEPRECATEDideaList:selectIdea', idea.id);
                                 }, 250);
                               }
                             });
      } else {
        //activate_tour = false;
        if (!lastSave
            || (Date.now() - lastSave.getTime() > (7 * 24 * 60 * 60 * 1000))
            ) {
          /* Reset the context of the user view, if it's too old to be
           usable, or if it wasn't initialized before */
           
          // Find if a group exists that has a navigation panel
          var navigableGroupSpec = groupSpecs.find(function(aGroupSpec) {
            return aGroupSpec.findNavigationSidebarPanelSpec();
          });
          if (navigableGroupSpec) {
            setTimeout(function() {
              var groupContent = groupsView.children.findByModel(navigableGroupSpec);
              groupContent.NavigationResetDefaultState();
            }, 0);
          }
        }
      }

      Assembl.groupContainer.show(groupsView);

      return Promise.resolve(groupsView);
    });
  },

  userHaveAccess: function() {
    /**
     * TODO: backend api know private discussion and can redirect to login
     * add this method to home page route
     * */
    var route = Backbone.history.fragment,
        access = false;

    if (!Ctx.getCurrentUserId()) {
      var authorization = new Authorization({
        error: 401,
        message: i18n.gettext('You must be logged in to access this page.')
      });
      Assembl.groupContainer.show(authorization);
      return;
    }

    switch (route){
      case 'edition':
      case 'settings':
      case 'notifications':
      case 'partners':
        access = (!Ctx.getCurrentUser().can(Permissions.ADMIN_DISCUSSION)) ? false : true;
        break;

      default:
        access = (!Ctx.getCurrentUser().can(Permissions.READ)) ? false : true;
        break;
    }

    if (!access) {
      var authorization = new Authorization({
        error: 401,
        message: i18n.gettext('Your level of permissions do not allow you to see the rest of this content')
      });
      Assembl.groupContainer.show(authorization);
    }

    return access;
  }

});

module.exports = new routeManager();
