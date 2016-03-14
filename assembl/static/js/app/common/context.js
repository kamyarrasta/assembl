'use strict';

var $ = require('../shims/jquery.js'),
    _ = require('../shims/underscore.js'),
    Moment = require('moment'),
    Promise = require('bluebird'),
    Assembl =  require('../app.js'),
    Permissions =  require('../utils/permissions.js'),
    Roles =  require('../utils/roles.js'),
    i18n =  require('../utils/i18n.js'),
    Raven = require('raven-js'),
    Analytics = require('../internal_modules/analytics/dispatcher.js');
require('linkifyjs');
require('linkifyjs/jquery')($);

var Context = function() {

  this.DISCUSSION_SLUG = $('#discussion-slug').val();
  this.DISCUSSION_ID = $('#discussion-id').val();
  this.SOCKET_URL = $('#socket-url').val();
  this.CURRENT_USER_ID = $('#user-id').val();
  /**
   * Send debugging output to console.log to observe when views render
   * @type {boolean}
   */
  this.debugRender = false;

  /**
   * Send debugging output to console.log to observe annotator related
   * events
   * @type {boolean}
   */
  this.debugAnnotator = false;

  /**
   * Send debugging output to console.log to observe socket input
   * @type {boolean}
   */
  this.debugSocket = false;

  /**
   * Prefix used to generate the id of the element used by annotator to find it's annotation
   * @type {string}
   */
  this.ANNOTATOR_MESSAGE_BODY_ID_PREFIX = "message-body-";

  /**
   * Current user
   * @type {User}
   */
  this._currentUser = null;

  /**
   * Csrf token
   * @type {String}
   */
  this.csrfToken = null;

  /**
   * Default ease for all kids of animation
   * @type {String}
   */
  this.ease = 'ease';

  /**
   * The date format
   * @type {String}
   */
  this.dateFormat = 'DD/MM/YYYY';

  /**
   * The datetime format
   * @type {string}
   */
  this.datetimeFormat = 'DD/MM/YYYY HH:mm:ss';

  /**
   * Current dragged segment
   * @type {Segment}
   */
  this._draggedSegment = null;

  /**
   * Current dragged idea
   * @type {Idea}
   */
  this.draggedIdea = null;

  /**
   * ID of Current synthesis draft
   * @type {String}
   */
  this.currentSynthesisDraftId = null;

  /**
   * Current synthesis draft promise
   * @type {Promise}
   */
  this.currentSynthesisDraftPromise = null;


  /**
   * Current dragged annotation
   * @type {Annotation}
   */
  this._draggedAnnotation = null;

  /**
   * The selection tooltip.
   * @type {jQuery}
   */
  this.annotatorSelectionTooltip = null;

  /**
   * Reference to dragbox
   * @type {HTMLDivElement}
   */
  this.dragbox = null;

  /**
   * Qty of opened panels
   * @type {Number}
   */
  this.openedPanels = 0;

  this.AVAILABLE_MESSAGE_VIEW_STYLES = {
    TITLE_ONLY: {
      id: "viewStyleTitleOnly",
      label: i18n.gettext('Message titles')
    },
    PREVIEW: {
      id: "viewStylePreview",
      label: i18n.gettext('Message previews')
    },
    FULL_BODY: {
      id: "viewStyleFullBody",
      label: i18n.gettext('Complete messages')
    }
  };

  /*
   * Current discussion
   * @type {Discussion}
   */
  this.discussion = undefined;

  /*
   * Current discussion Promise object
   * @type {Promise}
   */
  this.discussionPromise = undefined;

  /*
   * Timeout (created by setTimeout()) which hides the popover
   */
  this.timeoutIdHidePopover = null;

  /**
   * The view object of a current Modal
   * Every created modal must be manually added to this
   * property in order to maintain state.
   *
   * Used by Ctx.clearModal()
   */
  this.currentModalView = null;

  this.init();
}

Context.prototype = {

  getDiscussionSlug: function() {
    return this.DISCUSSION_SLUG;
  },

  getLoginURL: function() {
      return '/' + Ctx.getDiscussionSlug() + '/login';
    },

  getSocketUrl: function() {
    return this.SOCKET_URL;
  },

  getDiscussionId: function() {
    return this.DISCUSSION_ID;
  },

  getCurrentUserId: function() {
    return this.CURRENT_USER_ID;
  },

  getCurrentUser: function() {
    return this._currentUser;
  },

  setCurrentUser: function(user) {
    var analytics = Analytics.getInstance(),
        days_since_first_visit,
        last_login_buffer = 30; //seconds

    this._currentUser = user;
    if(!this._currentUser.isUnknownUser()) {
      analytics.setUserId(this._currentUser.id);

      //Hackish way to know if the USER_LOGIN event should be triggered
      var last_login = user.get('last_login');
      if (last_login) {
        var timezonedLogin = this.addUTCTimezoneToISO8601(last_login),
            now = new Moment().utc(),
            loginMoment = new Moment(timezonedLogin).utc(),
            acceptableTime = loginMoment.add(last_login_buffer, 'seconds');

        // Moment #isBefore has consequences http://momentjs.com/docs/#/query/is-before/
        if ( now.isBefore(acceptableTime) ) {
          //If within the acceptable timeframe, fire login event.
          analytics.trackEvent(analytics.events.USER_LOGIN);
        }
      }

      analytics.setCustomVariable(analytics.customVariables.HAS_ELEVATED_RIGHTS, this._currentUser.can(Permissions.EDIT_EXTRACT));
      
      if(this._currentUser.get('post_count') >= 1) {
        analytics.setCustomVariable(analytics.customVariables.HAS_POSTED_BEFORE, true);
      }
      else {
        analytics.setCustomVariable(analytics.customVariables.HAS_POSTED_BEFORE, false);
      }

      if(this._currentUser.get('first_visit') !== null && this._currentUser.get('last_visit') !== null) {
        //Note:  moment always rounds DOWN
        days_since_first_visit = Moment(this._currentUser.get('last_visit')).diff(this._currentUser.get('first_visit'), 'days');
        if(days_since_first_visit >= 1) {
          analytics.setCustomVariable(analytics.customVariables.IS_ON_RETURN_VISIT, true);
        }
        else {
          analytics.setCustomVariable(analytics.customVariables.IS_ON_RETURN_VISIT, false);
        }
      }

      var CollectionManager = require('./collectionManager.js'),
          collectionManager = new CollectionManager();

      collectionManager.getLocalRoleCollectionPromise().then(function(localRoles) {
        var logUserSubscriptionStatus = function(localRoles) {
          analytics.setCustomVariable(analytics.customVariables.IS_DISCUSSION_MEMBER, localRoles.isUserSubscribedToDiscussion());
        }
        localRoles.listenTo(localRoles, 'update', logUserSubscriptionStatus);
        logUserSubscriptionStatus(localRoles);
      });
      
      this.manageLastCurrentUser();

    }
  },

  getCsrfToken: function() {
    return this.csrfToken || this.loadCsrfToken(false);
  },

  setCsrfToken: function(token) {
    this.csrfToken = token;
  },

  /**
   * Returns a template from an script tag
   * @param {string} id The id of the script tag
   * @return {function} The Underscore.js _.template return
   */
  loadTemplate: function(id) {
    var template = $('#tmpl-' + id);
    if (template.length) {
      // Only for app page
      return _.template(template.html());
    }
  },

  /**
   * get a view style definition by id
   * @param {messageViewStyle.id}
   * @return {messageViewStyle or undefined}
   */
  getMessageViewStyleDefById: function(messageViewStyleId) {
    return _.find(this.AVAILABLE_MESSAGE_VIEW_STYLES, function(messageViewStyle) {
      return messageViewStyle.id == messageViewStyleId;
    });
  },

  getUrlFromUri: function(str) {
    var start = "local:";
    if (str && str.length && str.indexOf(start) == 0) {
      str = "/data/" + str.slice(start.length);
    }

    return str;
  },

  /**
   * Formats the url to the current api url
   * @param  {string} url
   * @return {string} The url formatted
   */
  getApiUrl: function(url) {
    if (url === undefined)
        url = '/';
    else if (url[0] !== '/') {
      url = '/' + url;
    }

    return '/api/v1/discussion/' + this.getDiscussionId() + url;
  },

  getApiV2Url: function(url) {
    if (url === undefined)
        url = '/';
    else if (url[0] !== '/') {
      url = '/' + url;
    }

    return '/data' + url;
  },

  getApiV2DiscussionUrl: function(url) {
    if (url === undefined)
        url = '/';
    else if (url[0] !== '/') {
      url = '/' + url;
    }

    return this.getApiV2Url('Discussion/' + this.getDiscussionId() + url);
  },

  /**
   * Formats the given to the generic api url
   * @param {string} id The class name used in the api
   * @return {string} The url formatted
   *
   * ex: 'local:Extract/1' -> '/api/v1/discussion/1/generic/Extract/1'
   */

   
  /**
   * @return {Object} The Object with mesagelistconfig in the localStorage
   */
  DEPRECATEDgetMessageListConfigFromStorage: function() {
    var messageListConfig = JSON.parse(localStorage.getItem('messageListConfig')) || {};
    return messageListConfig;
  },

  /**
   * Adds a panel in the localStorage
   * @param {Object} The Object with mesagelistconfig in the localStorage
   * @return {Object} The Object with mesagelistconfig in the localStorage
   */
  DEPRECATEDsetMessageListConfigToStorage: function(messageListConfig) {
    localStorage.setItem('messageListConfig', JSON.stringify(messageListConfig));
    return messageListConfig;
  },

  /**
   * Checks if there is a panel in fullscreen mode
   * ( i.e.: there is only one open )
   * @return {Boolean}
   */
  isInFullscreen: function() {
    return this.openedPanels === 1;
  },

  // "this" has to be the popover div: $("#popover-oembed")
  popoverAfterEmbed: function() {
    var screenWidth = Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
    var screenHeight = Math.max(document.documentElement.clientHeight, window.innerHeight || 0);
    var popoverWidth = $(this).outerWidth();
    var popoverHeight = $(this).outerHeight();
    var positionLeft = parseInt($(this).css('left'));
    var positionTop = parseInt($(this).css('top'));
    var newPositionLeft = positionLeft - popoverWidth / 2;
    if (newPositionLeft + popoverWidth > screenWidth)
        newPositionLeft = screenWidth - popoverWidth;
    if (newPositionLeft < 0)
        newPositionLeft = 0;
    var newPositionTop = positionTop;
    if (newPositionTop + popoverHeight > screenHeight)
        newPositionTop = screenHeight - popoverHeight;
    if (newPositionTop < 0)
        newPositionTop = 0;
    $(this).css('left', newPositionLeft + 'px');
    $(this).css('top', newPositionTop + 'px');
  },

  openTargetInPopOver: function(evt) {
    var that = this;

    var target_url = null;
    if (evt && evt.currentTarget) {
      if ($(evt.currentTarget).attr("data-href"))
          target_url = $(evt.currentTarget).attr("data-href");
      else if ($(evt.currentTarget).attr("href") && $(evt.currentTarget).attr("href") != "#")
          target_url = $(evt.currentTarget).attr("href");
    }

    if (!target_url) {
      console.log("context::openTargetInPopOver: no href attribute given");
      return false;
    }

    var popover_width = 500;
    var popover_height = 500;
    var popover_scrolling = "no";
    if (evt && evt.currentTarget) {
      if ($(evt.currentTarget).attr("data-popover-width"))
          popover_width = $(evt.currentTarget).attr("data-popover-width");
      if ($(evt.currentTarget).attr("data-popover-height"))
          popover_height = $(evt.currentTarget).attr("data-popover-height");
      if ($(evt.currentTarget).attr("data-popover-scrolling"))
          popover_scrolling = $(evt.currentTarget).attr("data-popover-scrolling");
    }

    var popover = $("#popover-oembed");

    var iframe = '<iframe width="' + popover_width + '" height="' + popover_height + '" frameborder="0" scrolling="' + popover_scrolling + '" frametransparency="1" src="' + target_url + '" style="display: block;"></iframe>'; // "display: block;" is added in order to avoid an empty space at the bottom of the iframe
    popover[0].innerHTML = iframe;

    var triggerHover = function(evt) {
      console.log("triggerHover() evt: ", evt);
      popover.css('position', 'fixed');
      popover.css('top', (evt.pageY - parseInt(popover_height) - 14) + 'px');
      popover.css('left', evt.pageX + 'px');

      //popover.css('padding', '25px 50px');
      popover.removeClass('hidden');

      that.popoverAfterEmbed.apply(popover[0]);

      window.clearTimeout(that.timeoutIdHidePopover);

      var hidePopover = function() {
        popover.addClass('hidden');
      };

      popover.unbind("mouseleave"); // this avoids handler accumulation (each call to the following popover.mouseleave() adds a handler)
      popover.mouseleave(function(evt) {
        that.timeoutIdHidePopover = setTimeout(hidePopover, 1000);
      });

      popover.unbind("mouseenter"); // this avoids handler accumulation (each call to the following popover.mouseenter() adds a handler)
      popover.mouseenter(function(evt) {
        window.clearTimeout(that.timeoutIdHidePopover);
      });

      // hide it after some time even if the user does not put the mouse inside the popover
      that.timeoutIdHidePopover = setTimeout(hidePopover, 4000);
    };

    triggerHover(evt);

    return false;
  },

  // Display options are retrieved from evt.currentTarget attributes or from the "options" parameter (Object used as an associative array).
  // Modal can be dynamically resized once the iframe is loaded, or on demand. 
  // TODO: options to set modal size
  openTargetInModal: function(evt, onDestroyCallback, options) {
    var target_url = null;
    if (evt && evt.currentTarget) {
      if ($(evt.currentTarget).attr("data-href"))
          target_url = $(evt.currentTarget).attr("data-href");
      else if ($(evt.currentTarget).attr("href") && $(evt.currentTarget).attr("href") != "#")
          target_url = $(evt.currentTarget).attr("href");
    } else if (_.isObject(options) && "target_url" in options){
        target_url = options.target_url;
    }

    if (!target_url)
        return false;

    var modal_title = "";
    if (evt && evt.currentTarget && $(evt.currentTarget).attr("data-modal-title"))
        modal_title = $(evt.currentTarget).attr("data-modal-title");
    else if ( _.isObject(options) && "modal_title" in options ){
        modal_title = options.modal_title;
    }

    var resizeIframeOnLoad = false;
    if (evt && evt.currentTarget && $(evt.currentTarget).attr("data-modal-resize-on-load"))
        resizeIframeOnLoad = $(evt.currentTarget).attr("data-modal-resize-on-load") != false && $(evt.currentTarget).attr("data-modal-resize-on-load") != "false";
    else if ( _.isObject(options) && "modal_resize_on_load" in options ){
        resizeIframeOnLoad = options.modal_resize_on_load;
    }

    var resizable = false;
    if (evt && evt.currentTarget && $(evt.currentTarget).attr("data-modal-resizable"))
        resizable = $(evt.currentTarget).attr("data-modal-resizable") != false && $(evt.currentTarget).attr("data-modal-resizable") != "false";
    else if ( _.isObject(options) && "modal_resizable" in options ){
        resizable = options.modal_resizable;
    }

    var model = new Backbone.Model();
    model.set("iframe_url", target_url);
    model.set("modal_title", modal_title);
    model.set("resizeIframeOnLoad", resizeIframeOnLoad);

    var className = 'group-modal popin-wrapper iframe-popin';
    if ( _.isObject(options) && "footer" in options && options.footer === false)
        className += " popin-without-footer";
    if (!resizable)
        className += " popin-fixed-size";

    var Modal = Backbone.Modal.extend({
      template: Ctx.loadTemplate('modalWithIframe'),
      className: className,
      cancelEl: '.close',
      keyControl: false,
      model: model
    });

    window.modal_instance = new Modal();
    if (onDestroyCallback)
        window.modal_instance.onDestroy = onDestroyCallback;

    window.askConfirmationForModalClose = function(confirmation_message){
      window.modal_instance.beforeCancel = function(){
        return confirm(confirmation_message);
      }
    };

    window.allowModalClose = function(){
      window.modal_instance.beforeCancel = function(){
        return true;
      }
    };

    window.exitModal = function() {
      window.modal_instance.destroy();
    };

    window.resizeIframe = function(iframe, retry) {
      if (!iframe)
          iframe = $(".iframe-popin iframe").get(0);
      if (!iframe)
          return;
      var modal = $(iframe).parents(".bbm-modal");
      if (!modal)
          return;
      //var maxHeight = document.body.scrollHeight - 135;
      var maxHeight = modal.get(0).scrollHeight - 135;
      //var maxWidth = document.body.scrollWidth - 135;
      var maxWidth = modal.get(0).scrollWidth - 40;
      var targetHeight = iframe.contentWindow.document.body.scrollHeight; // margins are not included (but paddings are)
      var targetWidth = iframe.contentWindow.document.body.scrollWidth;
      if ( targetHeight > maxHeight ){
        targetHeight = maxHeight;
      }
      if ( targetWidth > maxWidth ){
        targetWidth = maxWidth;
      }
      console.log("targetHeight: ", targetHeight);
      console.log("targetWidth: ", targetWidth);
      if (targetHeight > 10) {
        $(iframe).css("height", ""); // reset style which was originally calc(100vh - 100px);
        var addPixelsToCompensateMargins = 40;
        var animatingProperties = {
          "height": (targetHeight + addPixelsToCompensateMargins) + "px"
        };
        if (targetWidth > 10) {
          modal.css("min-width", "initial");
          $(iframe).css("width", ""); // reset style
          animatingProperties.width = (targetWidth + addPixelsToCompensateMargins) + "px";
        }

        $(iframe).animate(
            animatingProperties,
                    {
                      complete: function() {
                        $(this).css("display", "block"); // so that no white horizontal block is shown between iframe and footer or bottom limit of the modal
                      }
                    }
                );
      }
      else if (retry !== false) {
        setTimeout(function() {
          window.resizeIframe(iframe, false);
        }, 1000);
      }
    };

    Assembl.slider.show(window.modal_instance);

    return false; // so that we cancel the normal behaviour of the clicked link (aka making browser go to "target" attribute of the "a" tag)
  },

  getDraggedAnnotation: function() {
    return this._draggedAnnotation;
  },

  setDraggedAnnotation: function(annotation, annotatorEditor) {
    this._draggedAnnotation = annotation;
    this._annotatorEditor = annotatorEditor;
  },

  /**
   * @set {Segment}
   * Sets the current
   */
  setDraggedSegment: function(segment) {
      this._draggedSegment = segment;
    },

  /**
   * @return {Segment}
   */
  getDraggedSegment: function() {
    var segment = this._draggedSegment;

    //this.setDraggedSegment(null); not necessary;

    if (segment) {
      delete segment.attributes.highlights;
    }

    return segment;
  },

  /**
   * @return {Idea}
   */
  popDraggedIdea: function() {
    if (this.ideaList && this.draggedIdea) {

      Assembl.vent.trigger('ideaList:removeIdea', this.draggedIdea);
    }

    var idea = this.draggedIdea;
    this.draggedIdea = null;

    return idea;
  },

  getCurrentSynthesisDraftPromise: function() {
    // Preliminary code, may not be final architecture.
    if (this.currentSynthesisDraftPromise === null) {
      var that = this,
          CollectionManager = require('./collectionManager.js'),
          collectionManager = new CollectionManager();

      this.currentSynthesisDraftPromise = collectionManager.getAllSynthesisCollectionPromise().then(
        function(syntheses) {
          if (that.currentSynthesisDraftId !== null) {
            return synthesis.get(that.currentSynthesisDraftId);
          }
          var drafts = syntheses.where({is_next_synthesis: true});
          if (drafts.length == 1) {
            var current = drafts[0];
            that.currentSynthesisDraftId = current.id;
            return current;
          }
          return null;
        });
    }
    return this.currentSynthesisDraftPromise;
  },

  setCurrentSynthesisDraftId: function(id) {
    if (id !== this.currentSynthesisDraftId) {
      // TODO: Couple this with a system that will redraw panels dependent 
      // on current Synthesis.
      self.currentSynthesisDraftId = id;
      self.currentSynthesisDraftPromise = null;
    }
  },

  /**
   * fallback: synchronously load app.csrfToken
   */
  loadCsrfToken: function(async) {
    var that = this;
    $.ajax('/api/v1/token', {
      async: async,
      dataType: 'text',
      success: function(data) {
        that.setCsrfToken(data);
      }
    });
  },

  /**
   * Return the Post related to the given annotation
   * @param {Annotation} annotation
   * @return {Message}
   */
  getPostIdFromAnnotation: function(annotation) {
    var span = $(annotation.highlights[0]),
        messageId = span.closest('[id^="' + this.ANNOTATOR_MESSAGE_BODY_ID_PREFIX + '"]').attr('id');

    return messageId.substr(this.ANNOTATOR_MESSAGE_BODY_ID_PREFIX.length);
  },

  /**
   * Saves the current annotation if there is any
   */
  saveCurrentAnnotationAsExtract: function() {
    if (this.getCurrentUser().can(Permissions.ADD_EXTRACT)) {
      this._annotatorEditor.element.find('.annotator-save').click();
    } else {
      alert("Error: You don't have the permission to save this annotation as an extract.");
      this._annotatorEditor.element.find('.annotator-cancel').click();
    }

    //Saving the annotation as an extract is the end of the annotation's lifecycle
    this.setDraggedAnnotation(null);
  },

  /**
   * Creates the selection tooltip
   */
  __createAnnotatorSelectionTooltipDiv: function() {
    this.annotatorSelectionTooltip = $('<div>', { 'class': 'textbubble' });
    $(document.body).append(this.annotatorSelectionTooltip.hide());
  },

  /**
   * Shows the dragbox when user starts dragging an element
   * This method is designed to be called in a dragstart event listener.
   * @param  {Event} ev The event object
   * @param  {String} text The text to be shown in the .dragbox
   */
  showDragbox: function(ev, text, newExtract) {
    var dragbox_max_length = 25,
        that = this;

    if (ev && "originalEvent" in ev) {
      ev = ev.originalEvent;
    }

    if (this.dragbox === null) {
      this.dragbox = document.createElement('div');
      this.dragbox.className = 'dragbox';
      this.dragbox.setAttribute('hidden', 'hidden');

      $(document.body).append(this.dragbox);
    }

    this.dragbox.removeAttribute('hidden');

    text = text || i18n.gettext('Extract');

    if (text.length > dragbox_max_length) {
      text = text.substring(0, dragbox_max_length) + '...';
    }

    this.dragbox.innerHTML = text;

    if (ev && "dataTransfer" in ev) {
      if (newExtract) {
        ev.dataTransfer.dropEffect = "link";
        ev.dataTransfer.effectAllowed = 'link';
      } else {
        ev.dataTransfer.dropEffect = "move";
        ev.dataTransfer.effectAllowed = 'all';
      }
      if (window.BrowserDetect.browser == "Explorer") {
        ev.dataTransfer.setData("Text", text);
      } else {
        ev.dataTransfer.setData("text/plain", text);
        ev.dataTransfer.setDragImage(this.dragbox, 10, 10);
      }
    }

    if ( ev && "currentTarget" in ev ){
      $(ev.currentTarget).one("dragend", function() {
        that.dragbox.setAttribute('hidden', 'hidden');
      });
    }
  },

  /**
   * Return the current time
   * @return {timestamp}
   */
  getCurrentTime: function() {
    return (new Date()).getTime();
  },

  /**
   * Format string function
   * @param {string} string
   * @param {string} ...
   * @return {string}
   */
  format: function(str) {
    var args = [].slice.call(arguments, 1);

    return str.replace(/\{(\d+)\}/g, function(a, b) {
      return typeof args[b] != 'undefined' ? args[b] : a;
    });
  },

  /**
   * Format date
   * @param {Date|timestamp} date
   * @param {string} [format=app.dateFormat] The format
   * @return {string}
   */
  formatDate: function(date, format) {
    format = format || this.dateFormat;

    if (date === null) {
      return '';
    }

    date = new Moment(date);
    return date.format(format);
  },

  /**
   * Returns a fancy date (ex: a few seconds ago), or a formatted precise date if precise is true
   * @return {String}
   */
  getNiceDateTime: function(date, precise, with_time, forbid_future) {
    // set default values
    precise = (precise === undefined) ? false : precise;
    with_time = (with_time === undefined) ? true : with_time;

    //var momentDate = moment(date);

    // we assume that server datetimes are given in UTC format
    // (Right now, the server gives UTC datetimes but is not explicit enough because it does not append "+0000". So Moment thinks that the date is not in UTC but in user's timezone. So we have to tell it explicitly, using .utc())
    var momentDate = Moment.utc(date);
    momentDate.local(); // switch off UTC mode, which had been activated using .utc()

    if (forbid_future) { // server time may be ahead of us of some minutes. In this case, say it was now
      var now = Moment();
      var now_plus_delta = Moment().add(30, 'minutes');
      if (momentDate > now && momentDate < now_plus_delta)
          momentDate = now;
    }

    if (momentDate) {
      if (precise == true) {
        if (with_time == true)
            return momentDate.format('LLLL');
        else
            return momentDate.format('LL');
      }

      var one_year_ago = Moment().subtract(1, 'years');
      if (momentDate.isBefore(one_year_ago)) { // show the exact date
        return momentDate.format('L');
      }
      else { // show "x days ago", or something like that
        return momentDate.fromNow();
      }
    }

    return momentDate; // or date?
  },

  // without time
  getNiceDate: function(date, precise, forbid_future) {
    if (precise === undefined)
        precise = true;
    return this.getNiceDateTime(date, precise, false, true);
  },

  /**
   * Returns a nicely formatted date, but not an approximative expression (i.e. not "a few seconds ago")
   * @return {String}
   */
  getReadableDateTime: function(date) {
    return this.getNiceDateTime(date, true);
  },

  getErrorMessageFromAjaxError: function(response) {
    var message = response.responseText;
    try {
      message = JSON.parse(message);
      return message.error;  // may be undefined
    } catch (Exception) {
      // maybe a text message
    }

    var pos = message.indexOf('ERRMSG:');
    if (pos > 0) {
      message = message.substr(pos + 7);
      pos = message.indexOf("<");
      if (pos > 0) {
        message = message.substr(0, pos);
      }

      return message;
    }

    return null;
  },
   
  /**
   * Shows the segment source in the better way related to the source
   * e.g.: If it is an email, opens it, if it is a webpage, open in another window ...
   * @param {Segment} segment
   */
  showTargetBySegment: function(segment) {
    var target = segment.get('target');

    switch (target['@type']) {
      case 'Webpage':
        window.open(target.url, "_blank");
        break;

      default:

        // This will treat:
        // ['Email', 'Post', 'AssemblPost', 'SynthesisPost', 'ImportedPost', 'WidgetPost', 'IdeaProposalPost']

        var selector = this.format('[data-annotation-id="{0}"]', segment.id);

        Assembl.vent.trigger('messageList:showMessageById', segment.get('idPost'), function() {
          $(selector).highlight();
        });

        break;
    }
  },

  /**
   * @see http://blog.snowfinch.net/post/3254029029/uuid-v4-js
   * @return {String} an uuid
   */
   
  //FIXME: this method never use in app
  /*createUUID: function(){
   var uuid = "", i = 0, random;

   for (; i < 32; i++) {
   random = Math.random() * 16 | 0;

   if (i == 8 || i == 12 || i == 16 || i == 20) {
   uuid += "-";
   }

   uuid += (i == 12 ? 4 : (i == 16 ? (random & 3 | 8) : random)).toString(16);
   }

   return uuid;
   },*/
   
  /**
   * Given the string in the format "local:ModelName/{id}" returns the id
   * @param  {String} str
   * @return {String}
   */
  extractId: function(str) {
    return str.split('/')[1];
  },

  /**
   * @param  {Number} userID The user's ID
   * @param  {Number} [size=44] The avatar size
   * @return {String} The avatar's url formatted with the given size
   */
  formatAvatarUrl: function(userID, size) {
    size = size || 44;
    return this.format("/user/id/{0}/avatar/{1}", userID, size);
  },

  /** This removes (rather than escape) all html tags
   * @param  {String} html
   * @return {String} The new string without html tags
   */
  stripHtml: function(html) {
      if (!html) {
        //coerce type to string
        html = '';
      }

      var retval = $.trim($('<div>' + html + '</div>').text());

      //console.log("stripHtml called with", html, "returning ", retval);
      return retval;
    },

  /** Convert all applicable characters to HTML entities
   * @param  {String} html
   */
  htmlEntities: function(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  /**
   * Use the browser's built-in functionality to quickly and safely
   * escape the string
   */
  escapeHtml: function(str) {
      var div = document.createElement('div');
      div.appendChild(document.createTextNode(str));
      return div.innerHTML;
    },

  /**
   * UNSAFE with unsafe strings; only use on previously-escaped ones!
   */
  unescapeHtml: function(escapedStr) {
      var div = document.createElement('div');
      div.innerHTML = escapedStr;
      var child = div.childNodes[0];
      return child ? child.nodeValue : '';
    },

  /**
   * @event
   */
  onDropdownClick: function(e) {
    if (!e || !(e.target))
        return;
    var targetElement = $(e.target),
        toggle = undefined, 
        parent = undefined;
    
    if (targetElement.hasClass("dropdown-toggle")) {
      toggle = targetElement;
    }
    else {
      toggle = targetElement.parents(".dropdown-toggle").first();
    }

    if (!toggle) {
      console.warn("toggle element not found");
      return;
    }

    var dropdown = toggle.parent();

    if (!dropdown) {
      console.warn("dropdown element not found");
      return;
    }
    
    var onMouseLeave = function(e) {
      dropdown.removeClass('is-open');
      //e.stopPropagation(); // so that onDropdownClick() is not called again immediately after when we click
    };

    if (dropdown.hasClass('is-open')) {
      onMouseLeave();
      return;
    }

    dropdown.addClass('is-open');
    $(document.body).one('click', onMouseLeave);
  },

  /**
   * @event
   *
   * Note: If you wish to defer this calculation completely, add the parameter 'handled' to the jqxhr object, set to true
   * eg. Notable example is in admin/adminDiscussion.js
   */
  onAjaxError: function(ev, jqxhr, settings, exception) {

    if (jqxhr.handled)
        return;

    // ignore Ajax errors which come from outside (sub-)domains. This is useful for oembed related errors
    var getHostnameFromUrl = function(data) { // hostname examples: "localhost", "localhost:4321"
      var a = document.createElement('a');
      a.href = data;
      return a.hostname;
    };
    if (settings && "url" in settings && window.location.hostname != getHostnameFromUrl(settings.url))
    {
      console.log("ignoring Ajax error from outside domain: ", getHostnameFromUrl(settings.url));
      console.log("the URL which returned an error was: ", settings.url);
      return;
    }

    var message = i18n.gettext('ajax error message:');
    message = "url: " + settings.url + "\n" + message + "\n" + exception;

    var model = new Backbone.Model({
      msg: message,
      url: settings.url
    });

    var Modal = Backbone.Modal.extend({
      template: _.template($('#tmpl-ajaxError').html()),
      className: 'group-modal popin-wrapper modal-ajaxError',
      cancelEl: '.close, .js_close',
      model: model,
      initialize: function() {
        this.$('.bbm-modal').addClass('popin');
      },
      events: {
        'click .js_reload': 'reload'
      },

      onRender: function() {
        Raven.captureMessage('Reload popup presented to the user', {tags: { url: this.model.get("url") }});
      },

      reload: function() {
        window.location.reload()
      }

    });

    var modal = new Modal();

    $('#slider').html(modal.render().el);
  },

  setLocale: function(locale) {
    document.cookie = "_LOCALE_=" + locale + "; path=/";
    location.reload(true);
  },
  InterfaceTypes: {
    SIMPLE: "SIMPLE",
    EXPERT: "EXPERT"
  },
  /** Set the user interface the user wants
   * @param interface_id, one of SIMPLE, EXPERT
   * */
  setInterfaceType: function(interface_id) {
    document.cookie = "interface=" + interface_id + "; path=/";
    this._interfaceTypeCache = undefined;
    location.reload(true);
  },


  getCurrentInterfaceType: function() {
    if(this._interfaceTypeCache === undefined) {
      this._interfaceTypeCache = this.getCookieItem('interface');
    }
    var interfaceType = this._interfaceTypeCache;
    if (!this.canUseExpertInterface()) {
      interfaceType = this.InterfaceTypes.SIMPLE
    }
    else {
      if (interfaceType === null) {
        interfaceType = this.InterfaceTypes.EXPERT
      }
    }

    return interfaceType;
  },

  getCookieItem: function(sKey) {
    return decodeURIComponent(document.cookie.replace(new RegExp("(?:(?:^|.*;)\\s*" + encodeURIComponent(sKey).replace(/[\-\.\+\*]/g, "\\$&") + "\\s*\\=\\s*([^;]*).*$)|^.*$"), "$1")) || null;
  },

  canUseExpertInterface: function() {
    var user = this.getCurrentUser();
    if (user.can(Permissions.ADD_EXTRACT) ||
        user.can(Permissions.EDIT_EXTRACT) ||
        user.can(Permissions.EDIT_MY_EXTRACT) ||
        user.can(Permissions.ADD_IDEA) ||
        user.can(Permissions.EDIT_IDEA) ||
        user.can(Permissions.EDIT_SYNTHESIS) ||
        user.can(Permissions.SEND_SYNTHESIS) ||
        user.can(Permissions.ADMIN_DISCUSSION) ||
        user.can(Permissions.SYSADMIN)
        ) {
      return true;
    }
    else {
      return false;
    }
  },

  /**
   * scrolls to any dom element in the messageList.
   * Unlike scrollToMessage, the element must already be onscreen.
   * This is also called by views/message.js
   *
   * @param el: DOM element to scroll to
   * @param container: el's DOM container which will scroll
   * @param callback:  will be called once animation is complete
   * @param margin:  How much to scroll up or down from the top of the
   * element.  Default is 30px for historical reasons
   * @param animate:  Should the scroll be smooth
   */
  scrollToElement: function(el, container, callback, margin, animate) {
      //console.log("context::scrollToElement called with: ", el, container, callback, margin, animate);
      if (el && _.isFunction(container.size) && container.offset() !== undefined) {
        var panelOffset = container.offset().top,
            panelScrollTop = container.scrollTop(),
            elOffset = el.offset().top,
            target;
        margin = margin || 30;
        if (animate === undefined) {
          animate = true;
        }

        target = elOffset - panelOffset + panelScrollTop - margin;

        //console.log(elOffset, panelOffset, panelScrollTop, margin, target);
        if (animate) {
          container.animate({ scrollTop: target }, { complete: callback });
        }
        else {
          container.scrollTop(target);
          if (_.isFunction(callback)) {
            callback();
          }
        }
      }
    },

  convertUrlsToLinks: function(el) {
    $(el).linkify();
  },

  makeLinksShowOembedOnHover: function(el) {
    var that = this,
        popover = $("#popover-oembed");

    var timeoutIdHidePopover = null;

    var hidePopoverGenerator = function(timer){
      console.log("hidePopoverGenerator()");
      return function(evt){
        timeoutIdHidePopover = setTimeout(function() {
          popover.addClass('hidden');
        }, timer);
      };
    };

    var triggerHover = function(evt) {
      var LoaderView = require('../views/loader.js'),
      loader = new LoaderView(),
      loaderHtml = loader.render().el;
      
      popover.html(loaderHtml);
      popover.css('position', 'fixed');
      popover.css('top', (evt.pageY + 2) + 'px');
      popover.css('left', evt.pageX + 'px');

      //popover.css('padding', '25px 50px');
      popover.removeClass('hidden');

      popover.oembed($(this).attr("href"), {
        //initiallyVisible: false,
        embedMethod: "fill",

        //apikeys: {
        //etsy : 'd0jq4lmfi5bjbrxq2etulmjr',
        //},
        maxHeight: "90%", maxWidth: "90%",
        debug: false,
        onEmbedFailed: function() {
          console.log("onEmbedFailed (assembl)");
          popover.addClass('hidden');
        },
        onError: function(externalUrl, embedProvider, textStatus, jqXHR) {
          if (jqXHR) {
            // Do not reload assembl for an embed failure
            jqXHR.handled = true;
          }
          console.log('err:', externalUrl, embedProvider, textStatus);
        },
        afterEmbed: function() {
          that.popoverAfterEmbed.apply(this);
        },
        proxyHeadCall: function(url) {
          return "/api/v1/mime_type?url=" + encodeURIComponent(url);
        }
      });


      popover.unbind("mouseleave"); // this avoids handler accumulation (each call to the following popover.mouseleave() adds a handler)

      popover.mouseleave(hidePopoverGenerator(10));

      popover.unbind("mouseenter"); // this avoids handler accumulation (each call to the following popover.mouseenter() adds a handler)
      popover.mouseenter(function(evt) {
        window.clearTimeout(timeoutIdHidePopover);
      });
    };

    el.find("a").each(function(index){
      $(this).mouseenter(function(evt) {
        if ( timeoutIdHidePopover ){
          window.clearTimeout(timeoutIdHidePopover);
        }
        var timeoutIdShowPopover = null;
        var that = this;
        timeoutIdShowPopover = window.setTimeout(function() {
          triggerHover.call(that, evt);
        }, 800); // => this is how much time the mouse has to stay on the link in order to trigger the popover
        $(this).mouseout(function() {
          window.clearTimeout(timeoutIdShowPopover);
        });
      });
      $(this).mouseleave(hidePopoverGenerator(500));
    });

  },


  getTooltipsContainerSelector: function(){
    return "#tooltips";
  },

  /**
   * @init
   * TODO: This is very slow when the DOM contained in elm is big. Maybe we should improve this CSS selector (for example using a class selector instead of an attribute selector), but then we would have to edit the HTML of every element which declares a tooltip.
   */
  initTooltips: function(elm) {
    elm.find('[data-toggle="tooltip"]').tooltip({
      animation: true,
      container: this.getTooltipsContainerSelector(),
      delay: {"show": 500, "hide": 100}
    });
  },

  /**
   * Removes all tooltips from the screen.  Without this, active
   * tooltips (those currently displayed) will be left dangling
   * if the trigger element is removed from the dom.
   */
  removeCurrentlyDisplayedTooltips: function() {
    //console.log("removeCurrentlyDisplayedTooltips() called");
    //This really does need to be global.
    //Should be fast, so we have put all tooltips into #tooltips
    $('#tooltips').empty();
  },

  getAbsoluteURLFromRelativeURL: function(url) {
    if (url && url[0] == "/")
        url = url.substring(1);
    return this.format('{0}//{1}/{2}', location.protocol, location.host, url);
  },

  getAbsoluteURLFromDiscussionRelativeURL: function(url) {
    if (url && url[0] == "/")
        url = url.substring(1);
    return this.format('{0}//{1}/{2}/{3}', location.protocol, location.host, this.getDiscussionSlug(), url);
  },

  getRelativeURLFromDiscussionRelativeURL: function(url) {
    if (url && url[0] == "/")
        url = url.substring(1);
    return this.format('/{0}/{1}', this.getDiscussionSlug(), url);
  },

  /**
   * Helper function to add query string to a URL
   * @param  {[string]} url [The URL to append query string to]
   * @param  {[array]} params [An array of key-value objects denoting the query string, raw (unencoded)]
   * @return {[string]}        [The query string updated URL]
   */
  appendExtraURLParams: function(url, params){
    //console.log('append extra url:', url);
    if (!params || _.isEmpty(params)){
      return url;
    }

    if (_.isObject(params) && !(_.isArray(params))){
      // Sugar for single object input
      params = [params];
    }

    var urlHasParams = false,
        paramExists = false;
    
    if (url.indexOf('?') >= 0) {
      urlHasParams = true;
      var i = url.indexOf('?');
      var c = url.charAt(i+1);
      if (c) {
        paramExists = true;
      }
    }

    var qs = [],
        finalUrl = url.substring(0);

    _.each(params, function(p){
      qs.push($.param(p));
    });

    if (urlHasParams && !paramExists){
      finalUrl += qs.join('&');
    }
    else if (urlHasParams){
      finalUrl += '&' + qs.join('&');
    }
    else {
      // URL has no params
      finalUrl += "?" + qs.join('&');
    }

    //console.log('final url', finalUrl);
    return finalUrl;
  },

  manageLastCurrentUser: function() {
    var lastCurrentUserId = null,
        connectedUserId = null;

    if (window.localStorage.getItem('lastCurrentUser')) {
      lastCurrentUserId = window.localStorage.getItem('lastCurrentUser').split('/')[1];
    }

    if (this._currentUser.get('@id') !== Roles.EVERYONE) {
      connectedUserId = this._currentUser.get('@id').split('/')[1];
    }

    if(connectedUserId) {
      //We have a real user logged-in
      if (connectedUserId != lastCurrentUserId) {
        //Clear the preferences of the previous real user that used the computer
        console.info("Clearing preferences since the logged-in user changed, or there was no previous logged-in user")
        // Take the opportunity to completely clear localStorage, since it's 
        // unreliable so far...
        window.localStorage.clear();
      }
      window.localStorage.setItem('lastCurrentUser', this._currentUser.get('@id'));
    }
  },

  isUserConnected: function() {
    if (this._currentUser){
      return !this._currentUser.isUnknownUser();
    }
    else {return false; }
  },

  getLocale: function() {
      return assembl_locale.split('_')[0];
    },

  _test_set_locale: function(locale){
    assembl_locale = locale;
  },

  initLocale: function() {

    switch (assembl_locale){
      case 'en_CA':
        require('moment/locale/en-ca.js');
        break;
      case 'en_GB':
        require('moment/locale/en-gb.js');
      case 'de_AT':
        require('moment/locale/de-at.js');
        break;
      case 'de':
        require('moment/locale/de.js');
        break;
      case 'fr_CA':
        require('moment/locale/fr-ca.js');
        break;
      case 'fr_CH':
        require('moment/locale/fr-ch.js');
        break;
      case 'fr':
        require('moment/locale/fr.js');
        break;
      // otherwise english default
    }

    Moment.locale(this.getLocale());
  },

  /**
   * @init
   * inits ALL app components
   */
  init: function() {

    //Moment.locale(this.getLocale());

    $(document.body).removeClass('preload');
    this.__createAnnotatorSelectionTooltipDiv();

    //this.initTooltips($("body"));

    $(document).on('click', '.dropdown-toggle', this.onDropdownClick);
    $(document).on('ajaxError', this.onAjaxError);
  },

  debug: function(view, msg) {
    var log = debug(view + ':');
    log(msg);
  },

  /*
   * Get from database up-to-date information about current logged-in user.
   */
  updateCurrentUser: function() {
    var that = this;
    var user = null;
    if (this.getCurrentUserId()) {
      user = this.getCurrentUser();
      user.fetch({
        success: function(model, resp) {
          that.setCurrentUser(user);
          user.fetchPermissions();

          that.loadCsrfToken(true);
        }
      });
    } else {
      /*
      user = new Agents.Collection().getUnknownUser();
      that.setCurrentUser(user);
      that.loadCsrfToken(true);
      */
    }
  },

  getJsonFromScriptTag: function(id) {
    var script = document.getElementById(id),
        json;

    if (!script) {
      console.error(this.format("Script tag #{0} doesn't exist", id));
      return {};
    }

    try {
      json = JSON.parse(script.textContent);
    } catch (e) {
      console.log(script.textContent);
      throw new Error("Invalid json. " + e.message);
    }

    return json;
  },

  getPreferences: function() {
    if (this._discussionPreferences){
      return this._discussionPreferences;
    }
    this._discussionPreferences = this.getJsonFromScriptTag('preferences');
    return this._discussionPreferences;
  },

  hasTranslationService: function(){
    return !!this.getPreferences()["translation_service"];
  },

  writeJsonToScriptTag: function(json, id) {
    var script = document.getElementById(id);

    if (!script) { // TODO: maybe we could create it?
      console.error(this.format("Script tag #{0} doesn't exist", id));
      return;
    }

    try {
      script.textContent = JSON.stringify(json);
    } catch (e) {
      throw new Error("Invalid json. " + e.message);
    }
  },
  getPermissionTokenPromise: function(permission_sets, user_ids) {
    var permissions = _.map(permission_sets, function(p) {
      return "permissions=" + p.join(",");
    }).join("&");
    var url = this.getApiV2DiscussionUrl('perm_token') + "?" + permissions + "&" + _.map(
      user_ids, function(p) {
      return "user_id=" + p;
    }).join("&");
    return Promise.resolve($.get(url));
  },
  deanonymizationCifInUrl: function(url, callback) {
    var urlTemplate = _.template(url),
        serverUrl = document.URL,
        serverUrlComp1 = serverUrl.split('://', 2),
        serverUrlComp2 = serverUrlComp1[1].split('/', 1),
        cif_perms = [Permissions.READ_PUBLIC_CIF],
        user_perms = [Permissions.READ, Permissions.READ_PUBLIC_CIF],
        url_base = serverUrlComp1[0] + '://' + serverUrlComp2[0] + '/data/Discussion/' + Ctx.getDiscussionId();
    Promise.join(
        this.getPermissionTokenPromise([cif_perms, user_perms],
              ["local:AgentProfile/" + this.getCurrentUserId()]),
            function(token_data) {
              var cif_token = token_data[cif_perms.join(",")],
                  user_token = token_data[user_perms.join(",")];
              callback(urlTemplate({
                "url": encodeURIComponent(url_base + '/jsonld?token=' + cif_token),
                "user_url": encodeURIComponent(url_base + '/private_jsonld?token=' + user_token),
                "lang": assembl_locale,
                "user_ids": encodeURIComponent(token_data["user_ids"].join(","))
              }));
            });
  },
  /**
   * This assumes that the there is a 1:1 relationship
   * between the AgentProfile (the user) and FacebookAccount
   * 
   * @return {[String || undefined]} [Will either return the @id of
   * the fbAccount if it exists, else returns undefined]
   */
  getCurrentUserFacebookAccountId: function() {
    var currentUser = this.getCurrentUser();
    var accounts = currentUser.get('accounts');
    var fbAccount = _.find(accounts, function(account) {
      return (account['@type'] === "FacebookAccount");
    });
    if (fbAccount) {
      return fbAccount['@id'];
    }
    else { return undefined; }
  },

  /**
   * [A utility function to convert backend DateTime data (ISO 8601 String) into ISO 8601 String with UTC Timezone]
   * TODO: This function was taken from app/js/models/social.js. Refactor to use this Ctx version throughout codebase.
   * @param {[String]} e [Returns ISO 8601 String with UTC Timezone]
   */
  addUTCTimezoneToISO8601: function(e){
      if (/[Z]$|([+-]\d{2}:\d{2})$/.test(e) ) {
          return e;
      }
      else {
          return e + 'Z'; //Z: ISO 8601 UTC Timezone
      }
  },

  /*
    Utility method used to identify to Ctx the View object that is the modal
    Useful for closing the model in any part of the code instead of the
    context of where the Modal was instantiated.
   */
  setCurrentModalView: function(view){
    this.currentModalView = view;
  },

  /*
    Utility method to close the modal view properly
   */
  clearModal: function(){
    if (this.currentModalView){
      //Using a backbone modal
      this.currentModalView.destroy();
      //hard rendered into an element
      this.currentModalView = null; 
    }
  },

  /*
    Cache of the locale to locale-name
    The language names will be sent from the back-end in the language
    of the interface.

    eg. Interface language: EN
    eg. {"fr": "French"}

    eg. Interface language FR
    eg. {"fr": "Francais"}

    @return Object  Language cache
   */
  getLocaleToLanguageNameCache: function(){
    //The cache is only read once for efficiency
    if ( this.localeToLangNameCache ) {
      return this.localeToLangNameCache;
    }
    
    this.localeToLangNameCache = Ctx.getJsonFromScriptTag('translation-locale-names');
    return this.localeToLangNameCache;
  },

  /**
   * Executor of lazy code
   * ex :
   *
   * Normale code
   *
   * $(document).ready(function() {
   *  // a lot of li's, lets say 500
   *   $('li').each(function() {
   *       $(this).bind('click', function() {
   *           alert('Yeah you clicked me');
   *       });
   *   });
   * });
   *
   * After refactoring
   *
   *  $(document).ready(function() {
   *       // a lot of li's, lets say 500
   *       $('li').each(function() {
   *       var self = this, doBind = function() {
   *           $(self).bind('click', function() {
   *               alert('Yeah you clicked me');
   *           });
   *       };
   *       $.queue.add(doBind, this);
   *       });
   *  });
   *
   *
   * */
  queue: {
    _timer: null,
    _queue: [],
    add: function(fn, context, time) {
      var setTimer = function(time) {
        queue._timer = setTimeout(function() {
          time = queue.add();
          if (queue._queue.length) {
            setTimer(time);
          }
        }, time || 2);
      }

      if (fn) {
        queue._queue.push([fn, context, time]);
        if (queue._queue.length == 1) {
          setTimer(time);
        }

        return;
      }

      var next = queue._queue.shift();
      if (!next) {
        return 0;
      }

      next[0].call(next[1] || window);
      return next[2];
    },
    clear: function() {
      clearTimeout(queue._timer);
      queue._queue = [];
    }
  }

}

module.exports = new Context();
