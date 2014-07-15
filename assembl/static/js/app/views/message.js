define(['backbone', 'underscore', 'moment', 'ckeditor', 'app', 'models/message', 'i18n', 'permissions', 'views/messageSend'],
function(Backbone, _, Moment, ckeditor, app, Message, i18n, Permissions, MessageSendView){
    'use strict';

    var MIN_TEXT_TO_TOOLTIP = 5,
        TOOLTIP_TEXT_LENGTH = 10;

    /**
     * @class views.MessageView
     */
    var MessageView = Backbone.View.extend({
        availableMessageViewStyles: app.AVAILABLE_MESSAGE_VIEW_STYLES,
        /**
         * @type {String}
         */
        tagName: 'div',

        /**
         * @type {String}
         */
        className: 'message',

        /**
         * Flags if it is selecting a text or not
         * @type {Boolean}
         */
        isSelecting: true,

        /**
         * Flags if the message is hoisted
         * @type {Boolean}
         */
        isHoisted: false,

        /**
         * Is the reply box currently visible
         * @type {Boolean}
         */
        replyBoxShown: false,
    
        /**
         * @init
         * @param {MessageModel} obj the model
         */
        initialize: function(obj){
            /*this.listenTo(this, "all", function(eventName) {
                console.log("message event received: ", eventName);
            });
            this.listenTo(this.model, "all", function(eventName) {
                console.log("message model event received: ", eventName);
            });*/
            this.listenTo(this.model, 'replacedBy', this.onReplaced);
            this.listenTo(this.model, 'showBody', this.onShowBody);
            this.listenTo(this.model, 'change', this.render);
            this.messageListView = obj.messageListView;
            this.viewStyle = this.messageListView.defaultMessageStyle;
            this.messageListView.on('annotator:destroy', this.onAnnotatorDestroy, this);
            this.messageListView.on('annotator:initComplete', this.onAnnotatorInitComplete, this);
            
            /**
             * The collection of annotations loaded in annotator for this message.
             * They do not need to be re-loaded on render
             * @type {Annotation}
             */
            this.loadedAnnotations = {};
        },

        /**
         * The thread message template
         * @type {_.template}
         */
        template: app.loadTemplate('message'),

        /**
         * Meant for derived classes to override
         * @type {}
         */
        transformDataBeforeRender: function(data) {
            return data;
        },
        
        /**
         * Meant for derived classes to override
         * @type {}
         */
        postRender: function() {
            return;
        },

        /**
         * The render
         * @return {MessageView}
         */
        render: function(){
            app.trigger('render');
            var data = this.model.toJSON(),
                children,
                bodyFormatClass = null,
                level;
            level = this.currentLevel !== null ? this.currentLevel : 1;
            if( ! _.isUndefined(level) ){
                this.currentLevel = level;
            }
            app.cleanTooltips(this.$el);
            this.setViewStyle(this.viewStyle);
                
            data['id'] = data['@id'];
            data['date'] = app.formatDate(data.date);
            data['creator'] = this.model.getCreator();
            if(this.model.get('bodyMimeType')) {
                bodyFormatClass = "body_format_"+this.model.get('bodyMimeType').replace("/", "_"); 
            }
            data['bodyFormatClass'] = bodyFormatClass;
            data['viewStyle'] = this.viewStyle;
            // Do NOT change this, it's the message id stored in the database 
            // by annotator when storing message annotations
            // It has to contain ONLY raw content of the message provided by the
            // database for annotator to parse it back properly
            data['messageBodyId'] = app.ANNOTATOR_MESSAGE_BODY_ID_PREFIX + data['@id'];
            data['isHoisted'] = this.isHoisted;
            
            this.$el.attr("id","message-"+ data['@id']);
            data['read'] = this.model.get('read')
            data['user_is_connected'] = app.getCurrentUser() !== app.users.getUnknownUser();
            this.$el.addClass(data['@type']);
            if (this.model.get('read') || !data['user_is_connected']) {
                this.$el.addClass('read');
                this.$el.removeClass('unread');
            } else {
                this.$el.addClass('unread');
                this.$el.removeClass('read');
            }
            data = this.transformDataBeforeRender(data);
            this.$el.html( this.template(data) );
            app.initTooltips(this.$el);
            app.initClipboard();

            this.replyView = new MessageSendView({
                'allow_setting_subject': false,
                'reply_message': this.model,
                'body_help_message': i18n.gettext('Type your response here...'),
                'cancel_button_label': null,
                'send_button_label': i18n.gettext('Send your reply'),
                'subject_label': null,
                'mandatory_body_missing_msg': i18n.gettext('You did not type a response yet...'),
                'mandatory_subject_missing_msg': null
            });
            this.$('.message-replybox').append(this.replyView.render().el);

            this.postRender();
            /* TODO: BENOITG:  We should memorize which views are onscreen, and 
             * re-call initAnnotator as needed (once) and loadAnnotations
             * after a delay.  We have a reference to them in renderedMessageViewsCurrent
             * Right now we just re-re-re call initAnnotator
             */
            app.messageList.initAnnotator();
            this.loadAnnotations();
            if(this.replyBoxShown) {
                this.openReplyBox();
            }
            else {
                this.closeReplyBox();
            };
            
            return this;
        },
        
        /**
         * Render annotator's annotations in the message body
         * Safe to call multiple times, will not double load annotations.
         */
        loadAnnotations: function(){
            if(this.annotator && (this.viewStyle == this.availableMessageViewStyles.FULL_BODY) ) {
                var that = this,
                    annotations = this.model.getAnnotations(),
                    annotationsToLoad = [];
                
                _.each(annotations, function(annotation){
                    if(!(annotation['@id'] in that.loadedAnnotations)) {
                        annotationsToLoad.push(annotation);
                    }
                });
    
                // Loading the annotations
                if( annotationsToLoad.length ) {
                    // This call is synchronous I believe - benoitg
                    that.annotator.loadAnnotations( _.clone(annotationsToLoad) );
                    _.each(annotationsToLoad, function(annotation){
                        that.loadedAnnotations[annotation['@id']] = annotation;
                    });

                    setTimeout(function(){
                        that.renderAnnotations(annotationsToLoad);
                    }, 1);
                }
            }
        },
        
        /**
         * Render annotator's annotations in the message body
         */
        renderAnnotations: function(annotations){
            var that = this;
            _.each(annotations, function(annotation){
                var highlights = annotation.highlights,
                    func = app.showSegmentByAnnotation.bind(window, annotation);

                _.each(highlights, function(highlight){
                    highlight.setAttribute('data-annotation-id', annotation['@id']);
                    $(highlight).on('click', func);
                });
            });

        },
        
        /**
         * @event
         * param Annotator object
         */
        onAnnotatorInitComplete: function(annotator){
            this.annotator = annotator;

            //Normally render has been called by this point, no need for a full render
            this.loadAnnotations();
        },

        /**
         * @event
         */
        onAnnotatorDestroy: function(annotator){
            this.annotator = null;

            // Resets loaded annotations to initial
            this.loadedAnnotations = {};
        },
        
        /**
         * Hide the selection tooltip
         */
        hideTooltip: function(){
            app.selectionTooltip.hide();
        },

        /**
         * Shows the selection tooltip
         * @param  {number} x
         * @param  {number} y
         * @param  {string} text
         */
        showTooltip: function(x, y, text){
            var marginLeft = app.selectionTooltip.width() / -2,
                segment = text;

            text = text.substr(0, TOOLTIP_TEXT_LENGTH) + '...' + text.substr( - TOOLTIP_TEXT_LENGTH );

            app.selectionTooltip
              .show()
              .attr('data-segment', segment)
              .text(text)
              .css({ top: y, left: x, 'margin-left': marginLeft });
        },

        /**
         *  Focus on the reply box, and open it if closed
         **/
        focusReplyBox: function(){
            this.openReplyBox();

            var that = this;
            window.setTimeout(function(){
                that.$('.messageSend-body').focus();
            }, 100);
        },
        
        /**
         *  Opens the reply box the reply button
         */
        openReplyBox: function(){
            this.$('.message-replybox').show();
            this.replyBoxShown = true;
        },

        /**
         *  Closes the reply box
         */
        closeReplyBox: function(){
            this.$('.message-replybox').hide();
            this.replyBoxShown = false;
        },

        /**
         * Shows the options to the selected text
         * @param  {Number} x
         * @param  {Number} y
         */
        showSelectionOptions: function(x, y){
            this.hideTooltip();

            var annotator = this.$el.closest('#messageList-list').data('annotator');
            annotator.onAdderClick.call(annotator);

            if( app.messageList.annotatorEditor ){
                app.messageList.annotatorEditor.element.css({
                    'top': y,
                    'left': x
                });
            }
        },

        events: {
            
            'click .message-subheader': 'onMessageTitleClick',
            'click .readmore': 'onMessageTitleClick',
            'click .message-hoistbtn': 'onMessageHoistClick',

            //
            'click .message-replybox-openbtn': 'focusReplyBox',
            'click .messageSend-cancelbtn': 'closeReplyBox',
            //
            'mousedown .message-body': 'startSelection',
            'mousemove .message-body': 'doTheSelection',
            'mouseleave .message-body': 'onMouseLeaveMessageBody',
            'mouseenter .message-body': 'doTheSelection',

            // menu
            'click #message-markasunread': 'markAsUnread',
            'click #message-markasread': 'markAsRead'
        },

        
        /**
         * @event
         */
        onMessageHoistClick: function(ev){
            // we will hoist the post, or un-hoist it if it is already hoisted
            this.isHoisted = app.messageList.toggleFilterByPostId(this.model.getId());
            this.render(); // so that the isHoisted property will now be considered
        },
        
        /**
         * @event
         */
        onShowBody: function(){
            var read = this.model.get('read');
            
            if( read === false ){
                this.model.setRead(true);
            }
            this.setViewStyle(this.availableMessageViewStyles.FULL_BODY);
            this.render();
        },

        /**
         * You need to re-render after this
         */
        setViewStyle: function(style) {
            if(style == this.availableMessageViewStyles.TITLE_ONLY) {
                this.$el.removeClass(this.availableMessageViewStyles.FULL_BODY.id);
                this.$el.removeClass(this.availableMessageViewStyles.PREVIEW.id);
                this.$el.addClass(this.availableMessageViewStyles.TITLE_ONLY.id);
                this.viewStyle = style;
            }
            else if(style == this.availableMessageViewStyles.FULL_BODY){
                this.$el.removeClass(this.availableMessageViewStyles.TITLE_ONLY.id);
                this.$el.removeClass(this.availableMessageViewStyles.PREVIEW.id);
                this.$el.addClass(this.availableMessageViewStyles.FULL_BODY.id);
                this.model.set('collapsed', false);
                this.viewStyle = style;
            }
            else if(style == this.availableMessageViewStyles.PREVIEW){
                this.$el.removeClass(this.availableMessageViewStyles.TITLE_ONLY.id);
                this.$el.removeClass(this.availableMessageViewStyles.FULL_BODY.id);
                this.$el.addClass(this.availableMessageViewStyles.PREVIEW.id);
                this.model.set('collapsed', false);
                this.viewStyle = style;
            }
            else {
                console.log("unsupported view style :" + style );
            }
        },
        
        toggleViewStyle: function() {
            if(this.viewStyle == this.availableMessageViewStyles.FULL_BODY){
                this.setViewStyle(this.messageListView.defaultMessageStyle);
            }
            else {
                var read = this.model.get('read');
                if( read === false ){
                    this.model.setRead(true);
                }
                this.setViewStyle(this.availableMessageViewStyles.FULL_BODY);
            }
        },
        /**
         * @event
         */
        onMessageTitleClick: function(ev){
            this.toggleViewStyle();
            this.render();
            if (this.viewStyle == this.availableMessageViewStyles.FULL_BODY) {
                this.openReplyBox();
            }
        },

        /**
         * @event
         * Starts the selection tooltip
         */
        startSelection: function(){
            this.hideTooltip();
            this.isSelecting = true;
            this.$el.addClass('is-selecting');

            var that = this;

            app.doc.one('mouseup', function(ev){
                that.stopSelection(ev);
            });
        },

        /**
         * @event
         * Does the selection
         */
        doTheSelection: function(ev){
            if( ! this.isSelecting ){
                return;
            }

            if( $(ev.target).closest('.is-selecting').length === 0 ){
                // If it isn't inside the one which started, don't show it
                return;
            }

            var selectedText = app.getSelectedText(),
                text = selectedText.focusNode ? selectedText.getRangeAt(0).cloneContents() : '';

            text = text.textContent || '';

            if( text.length > MIN_TEXT_TO_TOOLTIP ){
                this.showTooltip(ev.clientX, ev.clientY, text);
            } else {
                this.hideTooltip();
            }
        },

        /**
         * @event
         */
        onMouseLeaveMessageBody: function(){
            if( this.isSelecting ){
                this.hideTooltip();
            }
        },

        /**
         * @event
         */
        stopSelection: function(ev){
            var isInsideAMessage = false,
                selectedText = app.getSelectedText(),
                user = app.getCurrentUser(),
                text = selectedText.focusNode ? selectedText.getRangeAt(0).cloneContents() : '';

            text = text.textContent || '';

            if( ev ){
                isInsideAMessage = $(ev.target).closest('.is-selecting').length > 0;
            }

            if( user.can(Permissions.ADD_EXTRACT) && this.isSelecting && text.length > MIN_TEXT_TO_TOOLTIP && isInsideAMessage ){
                this.showSelectionOptions(ev.clientX - 50, ev.clientY);
            } else if( !user.can(Permissions.ADD_EXTRACT) ){
                console.warn('User cannot make extractions');
            }

            this.isSelecting = false;
            this.$el.removeClass('is-selecting');
        },

        /**
         * @event
         */
         onReplaced: function(newObject) {
             this.setElement(newObject);
             // TODO André: also look at this one, please!
             // It will not be triggered for a while, though.
             this.render();
         },

        /**
         * Mark the current message as unread
         */
         markAsUnread: function(){
             this.model.setRead(false);
         },
         
         /**
          * Mark the current message as read
          */
         markAsRead: function(){
             this.model.setRead(true);
         }
    });


    return MessageView;

});
